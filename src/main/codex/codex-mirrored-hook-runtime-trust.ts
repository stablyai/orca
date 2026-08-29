import {
  codexAppServerCapabilityCache,
  getCodexAppServerHostKey
} from './codex-app-server-capability-cache'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS } from './codex-hook-trust-grant'
import {
  resolveCodexTrustGrantHost,
  type CodexTrustGrantHost,
  type ResolvedCodexTrustGrantHost
} from './codex-trust-grant-host'
import { captureCodexTrustConfig, restoreCodexTrustConfig } from './codex-trust-config-rollback'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import {
  getMirroredRuntimeTrustFingerprint,
  getMirroredRuntimeTrustScopeKey
} from './codex-mirrored-hook-runtime-trust-cache'
import {
  runCodexUserHookTrustRebaseSession,
  type CodexMirroredHookTrustGrant,
  type CodexUserHookTrustRebaseRequest,
  type CodexUserHookTrustRebaseResult
} from './codex-user-hook-trust-rebase-client'
import {
  computeTrustKey,
  getHookTrustKeyWriteVariants,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

export type { CodexMirroredHookTrustGrant }

type MirroredHookTrustSessionRunner = (
  request: CodexUserHookTrustRebaseRequest
) => Promise<CodexUserHookTrustRebaseResult>

type VerifiedRuntimeTrust = {
  fingerprint: string
  grants: readonly CodexMirroredHookTrustGrant[]
}

class MirroredRuntimeTrustRollbackError extends Error {}

let runSession: MirroredHookTrustSessionRunner = runCodexUserHookTrustRebaseSession
let resolveHost = resolveCodexTrustGrantHost
let restoreConfig = restoreCodexTrustConfig
const retryAfterByScope = new Map<string, number>()
const verifiedRuntimeTrustByScope = new Map<string, VerifiedRuntimeTrust>()

export function stampMirroredRuntimeTrustWithCurrentHashes(
  entries: readonly CodexTrustEntry[],
  grants: readonly CodexMirroredHookTrustGrant[]
): CodexTrustEntry[] {
  const grantByKey = new Map<string, CodexMirroredHookTrustGrant>()
  for (const grant of grants) {
    const normalizedKey = normalizeHookTrustKeyForLookup(grant.key)
    if (!grantByKey.has(normalizedKey)) {
      grantByKey.set(normalizedKey, grant)
    }
  }
  return entries.map((entry) => {
    const grant = grantByKey.get(normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
    return grant?.command === entry.command ? { ...entry, trustedHash: grant.currentHash } : entry
  })
}

export function clearHookTrustKeySeparatorVariants(
  tomlPath: string,
  keys: readonly string[]
): void {
  if (keys.length === 0) {
    return
  }
  removeHookTrustEntries(
    tomlPath,
    keys.flatMap((key) => getHookTrustKeyWriteVariants(key))
  )
}

export async function resolveMirroredRuntimeUserHookTrustEntries(args: {
  entries: readonly CodexTrustEntry[]
  systemEntries: readonly CodexTrustEntry[]
  systemHomePath: string
  runtimeHomePath: string
  tomlPath: string
  host?: CodexTrustGrantHost
}): Promise<CodexTrustEntry[]> {
  if (args.entries.length === 0) {
    return []
  }
  if (args.systemEntries.length !== args.entries.length) {
    return preserveExistingRuntimeHashes(args.entries, args.tomlPath)
  }
  const host = args.host ?? { kind: 'native' as const }
  const hostKey = getCodexAppServerHostKey(host)
  const scopeKey = getMirroredRuntimeTrustScopeKey(hostKey, args.runtimeHomePath)
  if (isCoolingDown(scopeKey)) {
    return preserveExistingRuntimeHashes(args.entries, args.tomlPath)
  }
  let resolvedHost: ResolvedCodexTrustGrantHost
  try {
    resolvedHost = await resolveHost(host)
  } catch {
    startRetryCooldown(scopeKey)
    return preserveExistingRuntimeHashes(args.entries, args.tomlPath)
  }
  return runExclusivelyForCodexTrustConfig(args.tomlPath, async () => {
    const fingerprint = getMirroredRuntimeTrustFingerprint(args, resolvedHost.binaryStamp)
    const cached = verifiedRuntimeTrustByScope.get(scopeKey)
    if (resolvedHost.binaryStamp && cached?.fingerprint === fingerprint) {
      return stampMirroredRuntimeTrustWithCurrentHashes(
        preserveExistingRuntimeHashes(args.entries, args.tomlPath),
        cached.grants
      )
    }
    verifiedRuntimeTrustByScope.delete(scopeKey)
    if (isCoolingDown(scopeKey)) {
      return preserveExistingRuntimeHashes(args.entries, args.tomlPath)
    }
    try {
      return await codexAppServerCapabilityCache.runWithFallback(
        hostKey,
        () => grantAndVerifyMirroredRuntimeTrust(args, resolvedHost, scopeKey),
        async () => preserveExistingRuntimeHashes(args.entries, args.tomlPath),
        isCodexAppServerUnsupportedError
      )
    } catch (error) {
      if (error instanceof MirroredRuntimeTrustRollbackError) {
        throw error
      }
      startRetryCooldown(scopeKey)
      return preserveExistingRuntimeHashes(args.entries, args.tomlPath)
    }
  })
}

async function grantAndVerifyMirroredRuntimeTrust(
  args: {
    entries: readonly CodexTrustEntry[]
    systemEntries: readonly CodexTrustEntry[]
    systemHomePath: string
    runtimeHomePath: string
    tomlPath: string
  },
  resolvedHost: ResolvedCodexTrustGrantHost,
  scopeKey: string
): Promise<CodexTrustEntry[]> {
  const snapshot = captureCodexTrustConfig(args.tomlPath)
  try {
    const approvedIndexes = await inspectApprovedSystemHooks(args, resolvedHost)
    const fallbackEntries = preserveExistingRuntimeHashes(args.entries, args.tomlPath)
    if (approvedIndexes.length === 0) {
      retryAfterByScope.delete(scopeKey)
      if (resolvedHost.binaryStamp) {
        verifiedRuntimeTrustByScope.set(scopeKey, {
          fingerprint: getMirroredRuntimeTrustFingerprint(args, resolvedHost.binaryStamp),
          grants: []
        })
      }
      return fallbackEntries
    }
    const approvedEntries = approvedIndexes.map((index) => args.entries[index]!)
    clearHookTrustKeySeparatorVariants(
      args.tomlPath,
      approvedEntries.map((entry) => computeTrustKey(entry))
    )
    const request = resolvedHost.buildRequest({
      runtimeHomePath: args.runtimeHomePath,
      managedCommand: '',
      expectedTrustKeys: []
    })
    const result = await runSession({
      operation: 'grant-mirrored-runtime-hook-trust',
      invocation: request.invocation,
      hooksListCwd: request.hooksListCwd,
      targets: approvedEntries.map((entry) => ({
        key: computeTrustKey(entry),
        command: entry.command,
        enabled: entry.enabled !== false
      }))
    })
    if (result.outcome !== 'mirrored-granted') {
      throw new Error('unexpected mirrored hook trust grant result')
    }
    const grantsByKey = new Map(
      result.entries.map((entry) => [normalizeHookTrustKeyForLookup(entry.key), entry.command])
    )
    if (
      grantsByKey.size !== approvedEntries.length ||
      approvedEntries.some(
        (entry) =>
          grantsByKey.get(normalizeHookTrustKeyForLookup(computeTrustKey(entry))) !== entry.command
      )
    ) {
      throw new Error('verified mirrored hook grant did not cover every approved entry')
    }
    const stamped = stampMirroredRuntimeTrustWithCurrentHashes(fallbackEntries, result.entries)
    retryAfterByScope.delete(scopeKey)
    if (resolvedHost.binaryStamp) {
      verifiedRuntimeTrustByScope.set(scopeKey, {
        fingerprint: getMirroredRuntimeTrustFingerprint(args, resolvedHost.binaryStamp),
        grants: result.entries
      })
    }
    return stamped
  } catch (error) {
    verifiedRuntimeTrustByScope.delete(scopeKey)
    try {
      restoreConfig(args.tomlPath, snapshot)
    } catch (rollbackError) {
      throw new MirroredRuntimeTrustRollbackError(
        'failed to restore runtime hook trust after mirrored grant failure',
        { cause: new AggregateError([error, rollbackError], 'grant and rollback both failed') }
      )
    }
    throw error
  }
}

async function inspectApprovedSystemHooks(
  args: {
    entries: readonly CodexTrustEntry[]
    systemEntries: readonly CodexTrustEntry[]
    systemHomePath: string
  },
  resolvedHost: ResolvedCodexTrustGrantHost
): Promise<number[]> {
  const request = resolvedHost.buildRequest({
    runtimeHomePath: args.systemHomePath,
    managedCommand: '',
    expectedTrustKeys: [],
    useDefaultCodexHome: true
  })
  const result = await runSession({
    operation: 'inspect-user-hook-trust',
    invocation: request.invocation,
    hooksListCwd: request.hooksListCwd,
    moves: args.systemEntries.map((entry, index) => ({
      oldKey: computeTrustKey(entry),
      newKey: computeTrustKey(args.entries[index]!),
      command: entry.command
    }))
  })
  if (result.outcome !== 'inspected' || result.moves.length !== args.entries.length) {
    throw new Error('unexpected mirrored system hook trust inspection result')
  }
  return result.moves.flatMap((move, index) =>
    move.currentHash === args.systemEntries[index]?.trustedHash ? [index] : []
  )
}

function preserveExistingRuntimeHashes(
  entries: readonly CodexTrustEntry[],
  tomlPath: string
): CodexTrustEntry[] {
  const existing = readHookTrustEntries(tomlPath)
  return entries.map((entry) => {
    const trustedHash = existing.get(computeTrustKey(entry))?.trustedHash
    // Why: a stale incoming hash preserves the old safe fallback; Codex trusts it only if it matches runtime currentHash.
    return trustedHash ? { ...entry, trustedHash } : entry
  })
}

function isCoolingDown(scopeKey: string): boolean {
  const retryAfter = retryAfterByScope.get(scopeKey)
  if (retryAfter === undefined) {
    return false
  }
  if (Date.now() < retryAfter) {
    return true
  }
  retryAfterByScope.delete(scopeKey)
  return false
}

function startRetryCooldown(scopeKey: string): void {
  retryAfterByScope.set(scopeKey, Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
}

export const _internals = {
  setSessionRunner(runner: MirroredHookTrustSessionRunner | null): void {
    runSession = runner ?? runCodexUserHookTrustRebaseSession
  },
  setHostResolver(resolver: typeof resolveCodexTrustGrantHost | null): void {
    resolveHost = resolver ?? resolveCodexTrustGrantHost
  },
  setConfigRestorer(restorer: typeof restoreCodexTrustConfig | null): void {
    restoreConfig = restorer ?? restoreCodexTrustConfig
  },
  resetState(): void {
    retryAfterByScope.clear()
    verifiedRuntimeTrustByScope.clear()
  }
}
