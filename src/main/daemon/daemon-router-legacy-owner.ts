import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { isDaemonEndpointGoneError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

/** Resolve legacy ownership before creating a duplicate; unknown owners require endpoint-loss and exit proof. */
export async function findLegacySessionOwner(
  opts: Pick<PtySpawnOptions, 'sessionId' | 'isNewSession' | 'attachOnly'>,
  current: DaemonPtyAdapter,
  legacy: readonly DaemonPtyAdapter[],
  exitProof: LegacyDaemonExitProof
): Promise<DaemonPtyAdapter | undefined> {
  const { sessionId } = opts
  if (!sessionId || opts.isNewSession || opts.attachOnly || legacy.length === 0) {
    return undefined
  }
  // Unreachable legacy daemons must not block the current daemon's proven sessions.
  if ((await probeOwnership(current, sessionId)).live === true) {
    return current
  }
  const verdicts = await Promise.all(
    legacy.map(async (adapter) => ({ adapter, ...(await probeOwnership(adapter, sessionId)) }))
  )
  exitProof.record(legacy)
  const owner = verdicts.find(({ live }) => live === true)
  if (owner) {
    return owner.adapter
  }
  // A missing PID may describe an old daemon while its replacement still owns the endpoint.
  const provenExited = (adapter: DaemonPtyAdapter, endpointGone: boolean): boolean =>
    endpointGone && exitProof.hasExited(adapter)
  if (
    verdicts.some(
      ({ adapter, live, endpointGone }) => live === null && !provenExited(adapter, endpointGone)
    )
  ) {
    throw new TerminalSessionOwnerUnverifiedError(sessionId)
  }
  return undefined
}

const LEGACY_OWNER_INVENTORY_MS = 2_000

async function probeOwnership(
  adapter: DaemonPtyAdapter,
  sessionId: string
): Promise<{ live: boolean | null; endpointGone: boolean }> {
  const live = await adapter.probePtyLiveness(sessionId).catch(() => null)
  if (live !== null) {
    return { live, endpointGone: false }
  }
  // Liveness probes do not reconnect; inventory can recover a failed startup connection.
  try {
    const processes = await adapter.listProcesses({
      deadlineMs: Date.now() + LEGACY_OWNER_INVENTORY_MS
    })
    return { live: processes.some((process) => process.id === sessionId), endpointGone: false }
  } catch (error) {
    return { live: null, endpointGone: isDaemonEndpointGoneError(error) }
  }
}
