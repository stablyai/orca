import { runCodexAppServerSession, type CodexAppServerInvocation } from './codex-app-server-session'
import { getHookTrustKeyWriteVariants, normalizeHookTrustKeyForLookup } from './config-toml-trust'

type CodexHookListing = {
  key: string
  command: string | null
  currentHash: string
  trustStatus: string
  enabled: boolean
}

function collectCodexHookListings(result: unknown): CodexHookListing[] {
  const data =
    result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)
      ? ((result as { data: unknown[] }).data as { hooks?: unknown }[])
      : []
  const listings: CodexHookListing[] = []
  const seenKeys = new Set<string>()
  for (const entry of data) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : []
    for (const hook of hooks as Record<string, unknown>[]) {
      if (
        typeof hook?.key !== 'string' ||
        typeof hook.currentHash !== 'string' ||
        typeof hook.trustStatus !== 'string'
      ) {
        continue
      }
      // Why: hooks/list repeats user-scope hooks per requested cwd; trust
      // rebasing must consider each key once.
      if (seenKeys.has(hook.key)) {
        continue
      }
      seenKeys.add(hook.key)
      listings.push({
        key: hook.key,
        command: typeof hook.command === 'string' ? hook.command : null,
        currentHash: hook.currentHash,
        trustStatus: hook.trustStatus,
        enabled: typeof hook.enabled === 'boolean' ? hook.enabled : true
      })
    }
  }
  return listings
}

export type CodexUserHookTrustMove = {
  oldKey: string
  newKey: string
  command: string
}

export type CodexCapturedUserHookTrustMove = CodexUserHookTrustMove & {
  reportedOldKey: string
  currentHash?: string
  wasTrusted: boolean
  enabled: boolean
}

type CodexUserHookTrustRebaseRequestBase = {
  invocation: CodexAppServerInvocation
  hooksListCwd: string
}

export type CodexUserHookTrustInspectRequest = CodexUserHookTrustRebaseRequestBase & {
  operation: 'inspect-user-hook-trust'
  moves: CodexUserHookTrustMove[]
}

export type CodexUserHookTrustRepairRequest = CodexUserHookTrustRebaseRequestBase & {
  operation: 'repair-user-hook-trust'
  moves: CodexCapturedUserHookTrustMove[]
}

export type CodexMirroredHookTrustTarget = {
  key: string
  command: string
  enabled: boolean
}

export type CodexMirroredHookTrustGrant = {
  key: string
  command: string
  currentHash: string
}

export type CodexMirroredHookTrustGrantRequest = CodexUserHookTrustRebaseRequestBase & {
  operation: 'grant-mirrored-runtime-hook-trust'
  targets: CodexMirroredHookTrustTarget[]
}

export type CodexUserHookTrustRebaseRequest =
  | CodexUserHookTrustInspectRequest
  | CodexUserHookTrustRepairRequest
  | CodexMirroredHookTrustGrantRequest

export type CodexUserHookTrustRebaseResult =
  | { outcome: 'inspected'; moves: CodexCapturedUserHookTrustMove[] }
  | { outcome: 'repaired'; repaired: number }
  | { outcome: 'mirrored-granted'; entries: CodexMirroredHookTrustGrant[] }

function matchingListings(
  listings: readonly CodexHookListing[],
  moves: readonly CodexUserHookTrustMove[],
  key: 'oldKey' | 'newKey'
): Map<string, CodexHookListing> {
  const expected = new Map(
    moves.map((move) => [normalizeHookTrustKeyForLookup(move[key]), move.command])
  )
  const matched = new Map<string, CodexHookListing>()
  for (const listing of listings) {
    const normalizedKey = normalizeHookTrustKeyForLookup(listing.key)
    if (expected.get(normalizedKey) !== listing.command) {
      continue
    }
    const existing = matched.get(normalizedKey)
    if (existing && !hookListingStatesAgree(existing, listing)) {
      throw new Error('hooks/list reported ambiguous hook key variants')
    }
    if (!existing) {
      matched.set(normalizedKey, listing)
    }
  }
  return matched
}

function hookListingStatesAgree(left: CodexHookListing, right: CodexHookListing): boolean {
  return (
    left.currentHash === right.currentHash &&
    left.trustStatus === right.trustStatus &&
    left.enabled === right.enabled
  )
}

function quotedKeyPath(key: string): string {
  const escaped = key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `hooks.state."${escaped}"`
}

async function inspectUserHookTrust(
  request: CodexUserHookTrustInspectRequest
): Promise<CodexUserHookTrustRebaseResult> {
  return runCodexAppServerSession(request.invocation, async ({ request: requestRpc }) => {
    const result = await requestRpc('hooks/list', { cwds: [request.hooksListCwd] })
    const byOldKey = matchingListings(collectCodexHookListings(result), request.moves, 'oldKey')
    if (byOldKey.size !== request.moves.length) {
      throw new Error(
        `pre-mutation hooks/list reported ${byOldKey.size} of ${request.moves.length} moved user hooks`
      )
    }
    return {
      outcome: 'inspected',
      moves: request.moves.map((move) => {
        const listing = byOldKey.get(normalizeHookTrustKeyForLookup(move.oldKey))!
        return {
          ...move,
          reportedOldKey: listing.key,
          currentHash: listing.currentHash,
          wasTrusted: listing.trustStatus === 'trusted',
          enabled: listing.enabled
        }
      })
    }
  })
}

async function repairUserHookTrust(
  request: CodexUserHookTrustRepairRequest
): Promise<CodexUserHookTrustRebaseResult> {
  return runCodexAppServerSession(request.invocation, async ({ request: requestRpc }) => {
    const result = await requestRpc('hooks/list', { cwds: [request.hooksListCwd] })
    const byNewKey = matchingListings(collectCodexHookListings(result), request.moves, 'newKey')
    if (byNewKey.size !== request.moves.length) {
      throw new Error(
        `post-mutation hooks/list reported ${byNewKey.size} of ${request.moves.length} moved user hooks`
      )
    }

    const oldKeys = request.moves.map((move) => move.reportedOldKey)
    const newKeys = Array.from(byNewKey.values(), (listing) => listing.key)
    const keysToClear = new Set([...oldKeys, ...newKeys].flatMap(getHookTrustKeyWriteVariants))
    const edits: { keyPath: string; value: unknown; mergeStrategy: 'replace' }[] = Array.from(
      keysToClear,
      (key) => ({
        keyPath: quotedKeyPath(key),
        value: null,
        mergeStrategy: 'replace' as const
      })
    )
    for (const move of request.moves) {
      const listing = byNewKey.get(normalizeHookTrustKeyForLookup(move.newKey))!
      if (move.wasTrusted) {
        edits.push({
          keyPath: quotedKeyPath(listing.key),
          value: {
            trusted_hash: listing.currentHash,
            ...(move.enabled ? {} : { enabled: false })
          },
          mergeStrategy: 'replace'
        })
      } else if (!move.enabled) {
        edits.push({
          keyPath: quotedKeyPath(listing.key),
          value: { enabled: false },
          mergeStrategy: 'replace'
        })
      }
    }
    await requestRpc('config/batchWrite', { edits, reloadUserConfig: true })

    const verified = await requestRpc('hooks/list', { cwds: [request.hooksListCwd] })
    const verifiedByKey = matchingListings(
      collectCodexHookListings(verified),
      request.moves,
      'newKey'
    )
    const invalid = request.moves.find((move) => {
      const listing = verifiedByKey.get(normalizeHookTrustKeyForLookup(move.newKey))
      return (
        !listing ||
        (listing.trustStatus === 'trusted') !== move.wasTrusted ||
        listing.enabled !== move.enabled
      )
    })
    if (invalid) {
      throw new Error(`post-rebase verify failed for moved user hook ${invalid.newKey}`)
    }
    return {
      outcome: 'repaired',
      repaired: request.moves.filter((move) => move.wasTrusted).length
    }
  })
}

function matchMirroredHookTargets(
  listings: readonly CodexHookListing[],
  targets: readonly CodexMirroredHookTrustTarget[]
): Map<string, CodexHookListing> {
  const expected = new Map(
    targets.map((target) => [normalizeHookTrustKeyForLookup(target.key), target.command])
  )
  if (expected.size !== targets.length) {
    throw new Error('mirrored hook trust request contains duplicate normalized keys')
  }
  const matched = new Map<string, CodexHookListing>()
  for (const listing of listings) {
    const normalizedKey = normalizeHookTrustKeyForLookup(listing.key)
    if (expected.get(normalizedKey) !== listing.command) {
      continue
    }
    const existing = matched.get(normalizedKey)
    if (existing && !hookListingStatesAgree(existing, listing)) {
      throw new Error('hooks/list reported ambiguous mirrored hook key variants')
    }
    if (!existing) {
      matched.set(normalizedKey, listing)
    }
  }
  if (matched.size !== targets.length) {
    throw new Error(
      `hooks/list matched ${matched.size} of ${targets.length} approved mirrored hooks`
    )
  }
  return matched
}

async function grantMirroredRuntimeHookTrust(
  request: CodexMirroredHookTrustGrantRequest
): Promise<CodexUserHookTrustRebaseResult> {
  return runCodexAppServerSession(request.invocation, async ({ request: requestRpc }) => {
    const listed = await requestRpc('hooks/list', { cwds: [request.hooksListCwd] })
    const byKey = matchMirroredHookTargets(collectCodexHookListings(listed), request.targets)
    const edits = request.targets.map((target) => {
      const listing = byKey.get(normalizeHookTrustKeyForLookup(target.key))!
      return {
        keyPath: quotedKeyPath(listing.key),
        value: {
          trusted_hash: listing.currentHash,
          ...(target.enabled ? {} : { enabled: false })
        },
        mergeStrategy: 'replace' as const
      }
    })
    await requestRpc('config/batchWrite', { edits, reloadUserConfig: true })

    const verified = await requestRpc('hooks/list', { cwds: [request.hooksListCwd] })
    const verifiedByKey = matchMirroredHookTargets(
      collectCodexHookListings(verified),
      request.targets
    )
    const invalid = request.targets.find((target) => {
      const normalizedKey = normalizeHookTrustKeyForLookup(target.key)
      const before = byKey.get(normalizedKey)!
      const after = verifiedByKey.get(normalizedKey)!
      return (
        after.currentHash !== before.currentHash ||
        after.trustStatus !== 'trusted' ||
        after.enabled !== target.enabled
      )
    })
    if (invalid) {
      throw new Error('post-write hooks/list verification failed for mirrored hook trust')
    }
    return {
      outcome: 'mirrored-granted',
      entries: request.targets.map((target) => {
        const listing = verifiedByKey.get(normalizeHookTrustKeyForLookup(target.key))!
        return { key: listing.key, command: target.command, currentHash: listing.currentHash }
      })
    }
  })
}

export function runCodexUserHookTrustRebaseSession(
  request: CodexUserHookTrustRebaseRequest
): Promise<CodexUserHookTrustRebaseResult> {
  if (request.operation === 'inspect-user-hook-trust') {
    return inspectUserHookTrust(request)
  }
  if (request.operation === 'repair-user-hook-trust') {
    return repairUserHookTrust(request)
  }
  return grantMirroredRuntimeHookTrust(request)
}
