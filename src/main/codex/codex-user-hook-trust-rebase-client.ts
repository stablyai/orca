import { runCodexAppServerSession, type CodexAppServerInvocation } from './codex-app-server-session'
import { normalizeHookTrustKeyForLookup } from './config-toml-trust'

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

export type CodexUserHookTrustRebaseRequest =
  | CodexUserHookTrustInspectRequest
  | CodexUserHookTrustRepairRequest

export type CodexUserHookTrustRebaseResult =
  | { outcome: 'inspected'; moves: CodexCapturedUserHookTrustMove[] }
  | { outcome: 'repaired'; repaired: number }

function matchingListings(
  listings: readonly CodexHookListing[],
  moves: readonly CodexUserHookTrustMove[],
  key: 'oldKey' | 'newKey'
): Map<string, CodexHookListing> {
  const expected = new Map(
    moves.map((move) => [normalizeHookTrustKeyForLookup(move[key]), move.command])
  )
  return new Map(
    listings
      .filter(
        (listing) => expected.get(normalizeHookTrustKeyForLookup(listing.key)) === listing.command
      )
      .map((listing) => [normalizeHookTrustKeyForLookup(listing.key), listing])
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

    const keysToClear = new Set([
      ...request.moves.map((move) => move.reportedOldKey),
      ...Array.from(byNewKey.values(), (listing) => listing.key)
    ])
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

export function runCodexUserHookTrustRebaseSession(
  request: CodexUserHookTrustRebaseRequest
): Promise<CodexUserHookTrustRebaseResult> {
  return request.operation === 'inspect-user-hook-trust'
    ? inspectUserHookTrust(request)
    : repairUserHookTrust(request)
}
