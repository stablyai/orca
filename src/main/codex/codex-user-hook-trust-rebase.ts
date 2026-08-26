import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import {
  codexAppServerCapabilityCache,
  getCodexAppServerHostKey,
  type CodexAppServerHostKey
} from './codex-app-server-capability-cache'
import { runCodexUserHookTrustRebaseSession } from './codex-app-server-grant-bridge'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS } from './codex-hook-trust-grant'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { resolveCodexTrustGrantHost } from './codex-trust-grant-host'
import {
  captureCodexTrustConfig,
  type CodexTrustConfigSnapshot
} from './codex-trust-config-rollback'
import { restoreCodexTrustFilesIfUnchanged } from './codex-trust-config-generation'
import { computeTrustKey, type CodexTrustEntry } from './config-toml-trust'
import type {
  CodexUserHookTrustRebaseRequest,
  CodexUserHookTrustRebaseResult,
  CodexUserHookTrustMove
} from './codex-user-hook-trust-rebase-client'

type HooksByEvent = Record<string, HookDefinition[]>

type RebaseSessionRunner = (
  request: CodexUserHookTrustRebaseRequest
) => Promise<CodexUserHookTrustRebaseResult> | CodexUserHookTrustRebaseResult

let runSession: RebaseSessionRunner = runCodexUserHookTrustRebaseSession

// Why: launch prep re-runs the callers on every pane spawn. A host stuck
// without a usable rebase lane (old CLI, unmatched keys) must not pay a codex
// session each time — bound retries like the grant lane does.
const rebaseRetryAfterByHost = new Map<CodexAppServerHostKey, number>()

function rememberRebaseSessionFailure(hostKey: CodexAppServerHostKey, error: unknown): void {
  if (isCodexAppServerUnsupportedError(error)) {
    codexAppServerCapabilityCache.rememberUnsupported(hostKey)
    return
  }
  rebaseRetryAfterByHost.set(hostKey, Date.now() + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
}

function entriesByHookObject(
  sourcePath: string,
  hooksByEvent: HooksByEvent
): Map<HookCommandConfig, CodexTrustEntry> {
  const result = new Map<HookCommandConfig, CodexTrustEntry>()
  for (const [eventName, definitions] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      if (!Array.isArray(definition.hooks)) {
        return
      }
      definition.hooks.forEach((hook, handlerIndex) => {
        const entry = createCodexHookTrustEntry(
          sourcePath,
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (entry) {
          result.set(hook, entry)
        }
      })
    })
  }
  return result
}

export function getMovedCodexUserHookTrust(
  sourcePath: string,
  beforeHooks: HooksByEvent,
  afterHooks: HooksByEvent
): CodexUserHookTrustMove[] {
  const before = entriesByHookObject(sourcePath, beforeHooks)
  const after = entriesByHookObject(sourcePath, afterHooks)
  const moves: CodexUserHookTrustMove[] = []
  for (const [hook, oldEntry] of before) {
    const newEntry = after.get(hook)
    if (!newEntry) {
      continue
    }
    const oldKey = computeTrustKey(oldEntry)
    const newKey = computeTrustKey(newEntry)
    if (oldKey !== newKey) {
      moves.push({ oldKey, newKey, command: oldEntry.command })
    }
  }
  return moves
}

function rollbackMutation(
  sourcePath: string,
  tomlPath: string,
  hooksSnapshot: CodexTrustConfigSnapshot,
  hooksAfterWrite: CodexTrustConfigSnapshot,
  configSnapshot: CodexTrustConfigSnapshot,
  configBeforeRepair: CodexTrustConfigSnapshot,
  originalError: unknown
): never {
  const restored = restoreCodexTrustFilesIfUnchanged([
    { path: tomlPath, snapshot: configSnapshot, expectedCurrent: configBeforeRepair },
    { path: sourcePath, snapshot: hooksSnapshot, expectedCurrent: hooksAfterWrite }
  ])
  if (!restored) {
    console.warn('[codex-user-hook-trust] files changed during repair; stale rollback skipped')
  }
  throw originalError
}

export async function mutateRealHomeHooksPreservingUserTrust(args: {
  sourcePath: string
  runtimeHomePath: string
  tomlPath: string
  beforeHooks: HooksByEvent
  afterHooks: HooksByEvent
  writeHooks: () => void
  restoreHooks: () => void
}): Promise<CodexTrustConfigSnapshot | null> {
  const moves = getMovedCodexUserHookTrust(args.sourcePath, args.beforeHooks, args.afterHooks)
  if (moves.length === 0) {
    args.writeHooks()
    return null
  }
  const hostKey = getCodexAppServerHostKey({ kind: 'native' })
  if (!codexAppServerCapabilityCache.shouldTry(hostKey)) {
    throw new Error('codex app-server is marked unsupported on this host; trust rebase skipped')
  }
  const retryAfterMs = rebaseRetryAfterByHost.get(hostKey)
  if (retryAfterMs !== undefined) {
    if (Date.now() < retryAfterMs) {
      throw new Error('Codex user hook trust rebase is cooling down after a recent failure')
    }
    rebaseRetryAfterByHost.delete(hostKey)
  }
  const snapshot = captureCodexTrustConfig(args.tomlPath)

  const baseRequest = resolveCodexTrustGrantHost({ kind: 'native' }).buildRequest({
    runtimeHomePath: args.runtimeHomePath,
    managedCommand: '',
    expectedTrustKeys: [],
    useDefaultCodexHome: true
  })
  // Why: inspection happens before the write, so an unavailable RPC aborts
  // without shifting a user's positional trust key.
  let inspected: CodexUserHookTrustRebaseResult
  try {
    inspected = await runSession({
      operation: 'inspect-user-hook-trust',
      invocation: baseRequest.invocation,
      hooksListCwd: baseRequest.hooksListCwd,
      moves
    })
  } catch (error) {
    rememberRebaseSessionFailure(hostKey, error)
    throw error
  }
  codexAppServerCapabilityCache.rememberSupported(hostKey)
  if (inspected.outcome !== 'inspected') {
    throw new Error('Unexpected Codex user hook trust inspection result')
  }

  let hooksWritten = false
  const hooksSnapshot = captureCodexTrustConfig(args.sourcePath)
  const configBeforeRepair = captureCodexTrustConfig(args.tomlPath)
  let hooksAfterWrite: CodexTrustConfigSnapshot | null = null
  try {
    args.writeHooks()
    hooksWritten = true
    hooksAfterWrite = captureCodexTrustConfig(args.sourcePath)
    const repaired = await runSession({
      operation: 'repair-user-hook-trust',
      invocation: baseRequest.invocation,
      hooksListCwd: baseRequest.hooksListCwd,
      moves: inspected.moves
    })
    if (repaired.outcome !== 'repaired') {
      throw new Error('Unexpected Codex user hook trust repair result')
    }
    return snapshot
  } catch (error) {
    rememberRebaseSessionFailure(hostKey, error)
    if (hooksWritten && hooksAfterWrite) {
      return rollbackMutation(
        args.sourcePath,
        args.tomlPath,
        hooksSnapshot,
        hooksAfterWrite,
        snapshot,
        configBeforeRepair,
        error
      )
    }
    throw error
  }
}

export const _internals = {
  setSessionRunner(runner: RebaseSessionRunner | null): void {
    runSession = runner ?? runCodexUserHookTrustRebaseSession
  },
  setSessionRunnerSync(runner: RebaseSessionRunner | null): void {
    runSession = runner ?? runCodexUserHookTrustRebaseSession
  },
  resetRetryState(): void {
    rebaseRetryAfterByHost.clear()
  }
}
