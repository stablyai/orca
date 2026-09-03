import type { Store } from '../../../persistence'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { parseAppSshPtyId, toRelaySshPtyId } from '../../../providers/ssh-pty-id'

/** Bounded so a slow relay leaves the fallback spawn on today's timing, not blocked behind a probe. */
export const RELAY_AGE_STATUS_TIMEOUT_MS = 2_000

/**
 * Slack between two independently measured elapsed times — the client's clock over the binding and
 * the host's own uptime counter. Both are durations, so no clock-offset correction is possible or
 * needed; this only absorbs jitter and the gap between daemon start and the first binding write.
 */
export const RELAY_AGE_CLOCK_SLACK_MS = 30_000

/**
 * Startup intent replayed by the absence fallback. Mirrors the set `attachStablePaneOwner` already
 * strips for an attach: everything that would run an agent, a resume argv, or a claim in the shell.
 */
export function stripStartupIntent(options: PtySpawnOptions): PtySpawnOptions {
  return {
    ...options,
    command: undefined,
    commandDelivery: undefined,
    startupCommandDelivery: undefined,
    launchAgent: undefined,
    startupIngress: undefined,
    agentSessionEnsure: undefined,
    agentSessionCreateOperationId: undefined
  }
}

export function carriesStartupIntent(options: PtySpawnOptions): boolean {
  return Boolean(
    options.command ||
    options.launchAgent ||
    options.startupIngress ||
    options.agentSessionEnsure ||
    options.agentSessionCreateOperationId
  )
}

/** Age of the lease that recorded this SSH binding, or null when nothing dates it. */
function bindingAgeMs(
  store: Store | undefined,
  connectionId: string,
  ptyId: string,
  now: number
): number | null {
  if (!store || typeof store.getSshRemotePtyLeases !== 'function') {
    return null
  }
  const parsed = parseAppSshPtyId(ptyId)
  if (!parsed || parsed.connectionId !== connectionId) {
    return null
  }
  let createdAt: number | null = null
  for (const lease of store.getSshRemotePtyLeases(connectionId)) {
    if (
      toRelaySshPtyId(connectionId, lease.ptyId) !== parsed.relayPtyId ||
      typeof lease.createdAt !== 'number' ||
      !Number.isFinite(lease.createdAt)
    ) {
      continue
    }
    createdAt = createdAt === null ? lease.createdAt : Math.min(createdAt, lease.createdAt)
  }
  if (createdAt === null) {
    return null
  }
  const age = now - createdAt
  return Number.isFinite(age) && age > 0 ? age : null
}

/**
 * Does the relay that just answered "that PTY is absent" predate the binding it answered about?
 *
 * A daemon whose reported uptime is shorter than the binding's age cannot have owned the bound
 * process, so its positive absence is `unverifiable` rather than `exited`
 * (docs/reference/ssh-execution-boundary.md) — the shell it named may still be alive as an orphan
 * of the daemon it replaced. Only an answer that ARRIVES and is demonstrably younger says so:
 * a missing provider, a rejected or timed-out `relay.status`, an absent or unusable `uptimeMs`,
 * and an undatable binding all return false, leaving the caller on today's behavior. Silence is
 * never promoted to a verdict here.
 *
 * Reads only fields `relay.status` already publishes; adds no request field and no opcode.
 */
export async function answeringRelayPredatesBinding(args: {
  provider: IPtyProvider
  store?: Store | undefined
  connectionId?: string | null
  ptyId: string
  now?: () => number
}): Promise<boolean> {
  const { provider, connectionId, ptyId } = args
  if (!connectionId) {
    return false
  }
  const age = bindingAgeMs(args.store, connectionId, ptyId, (args.now ?? Date.now)())
  if (age === null) {
    return false
  }
  let status: unknown
  try {
    // Optional call: a provider with no host RPC yields undefined, which is not an answer.
    status = await provider.requestHostRpc?.(
      'relay.status',
      {},
      {
        timeoutMs: RELAY_AGE_STATUS_TIMEOUT_MS
      }
    )
  } catch {
    return false
  }
  if (!status || typeof status !== 'object') {
    return false
  }
  const uptimeMs = (status as { uptimeMs?: unknown }).uptimeMs
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    return false
  }
  return age > uptimeMs + RELAY_AGE_CLOCK_SLACK_MS
}

/**
 * The absence fallback's spawn, minus the startup intent a replacement relay never held.
 *
 * Returns null whenever nothing proves a replacement, leaving the caller on its unchanged path —
 * the spawn itself is never gated here, only the intent replayed into it.
 */
export async function spawnWithoutReplayedIntent(args: {
  provider: IPtyProvider
  store?: Store | undefined
  connectionId?: string | null
  ptyId: string
  spawnOptions: PtySpawnOptions
  onFreshSpawn?: (result: PtySpawnResult) => void
}): Promise<PtySpawnResult | null> {
  if (!carriesStartupIntent(args.spawnOptions) || !(await answeringRelayPredatesBinding(args))) {
    return null
  }
  const result = await args.provider.spawn(stripStartupIntent(args.spawnOptions))
  args.onFreshSpawn?.(result)
  return { ...result, agentResumeUnavailable: true as const }
}
