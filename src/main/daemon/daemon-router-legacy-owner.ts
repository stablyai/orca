import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { LegacyDaemonExitProof } from './daemon-legacy-exit-proof'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

/**
 * The daemon still running an unrouted session id, or undefined when none does. Why: a spawn of
 * that id on the current daemon starts a second session under it, and the next stop of the id
 * lands on the old one's live agent. A legacy daemon that cannot answer is not proof of death,
 * so it refuses unless its pid is proven gone.
 */
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
  // Why first: an unreachable legacy daemon must not block reattaching the current daemon's own session.
  if ((await probeOwnership(current, sessionId)) === true) {
    return current
  }
  const verdicts = await Promise.all(
    legacy.map(async (adapter) => ({
      adapter,
      live: await probeOwnership(adapter, sessionId)
    }))
  )
  exitProof.record(legacy)
  const owner = verdicts.find(({ live }) => live === true)
  if (owner) {
    return owner.adapter
  }
  if (verdicts.some(({ adapter, live }) => live === null && !exitProof.hasExited(adapter))) {
    throw new TerminalSessionOwnerUnverifiedError(sessionId)
  }
  return undefined
}

const LEGACY_OWNER_INVENTORY_MS = 2_000

async function probeOwnership(
  adapter: DaemonPtyAdapter,
  sessionId: string
): Promise<boolean | null> {
  const live = await adapter.probePtyLiveness(sessionId).catch(() => null)
  if (live !== null) {
    return live
  }
  // Why: the probe never reconnects, so a daemon whose startup connect failed would refuse forever.
  try {
    const processes = await adapter.listProcesses({
      deadlineMs: Date.now() + LEGACY_OWNER_INVENTORY_MS
    })
    return processes.some((process) => process.id === sessionId)
  } catch {
    return null
  }
}
