import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { readProcessStartTimeMs } from '../../agent-session/ownership/agent-session-process-identity-probe'
import { isProcessAlive } from '../../../daemon/endpoint/identity/daemon-process-inspection'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'

type ListingController = Pick<RuntimePtyController, 'listProcesses'>
type RememberedRoot = {
  incarnationId: string | undefined
  pid: number
  /** Undefined until first used: a shared listing names roots it does not verify. */
  startedAtMs?: number | null
}

const rootByPtyId = new Map<string, RememberedRoot>()
let sharedListing: Promise<void> | null = null

/** A local terminal's root process, or 'replaced' when the PTY is no longer the expected incarnation.
 * Why remembered: an older daemon lists every session to answer for one, and the root never changes within an incarnation. */
export async function readLegacyPtyRootProcessId(
  controller: ListingController,
  ptyId: string,
  expectedIncarnationId?: string,
  remember = true
): Promise<number | 'replaced' | null> {
  if (!remember) {
    return readTargetRoot(controller, ptyId, expectedIncarnationId)
  }
  let remembered = rootByPtyId.get(ptyId)
  if (!remembered || !matchesIncarnation(remembered, expectedIncarnationId)) {
    // Why one shared listing: each cold terminal listing every session alone costs terminals × sessions.
    sharedListing ??= rememberAllRoots(controller).finally(() => {
      sharedListing = null
    })
    await sharedListing
    remembered = rootByPtyId.get(ptyId)
    if (!remembered) {
      return null
    }
    if (!matchesIncarnation(remembered, expectedIncarnationId)) {
      return 'replaced'
    }
  }
  const startedAtMs = await readProcessStartTimeMs(remembered.pid)
  if (remembered.startedAtMs === undefined) {
    remembered.startedAtMs = startedAtMs
  }
  // Why the start time and liveness: a reused PID, or an exited root, must not stand in for this terminal's root.
  if (
    startedAtMs === remembered.startedAtMs &&
    (startedAtMs !== null || isProcessAlive(remembered.pid))
  ) {
    return remembered.pid
  }
  // The next probe relists; this one proves nothing about a root that changed under it.
  rootByPtyId.delete(ptyId)
  return null
}

/** The root lives as long as its terminal: bounded by live PTYs, not a size cap that would thrash. */
export function forgetLegacyPtyRoot(ptyId: string): void {
  rootByPtyId.delete(ptyId)
}

function matchesIncarnation(root: RememberedRoot, expected: string | undefined): boolean {
  // Why an absent incarnation matches: older daemons report none, and the start time fences replacement.
  return !root.incarnationId || !expected || root.incarnationId === expected
}

async function rememberAllRoots(controller: ListingController): Promise<void> {
  for (const pane of (await controller.listProcesses?.(LOCAL_EXECUTION_HOST_ID)) ?? []) {
    const known = rootByPtyId.get(pane.id)
    if (
      pane.rootProcessId &&
      (known?.pid !== pane.rootProcessId || known.incarnationId !== pane.incarnationId)
    ) {
      rootByPtyId.set(pane.id, { incarnationId: pane.incarnationId, pid: pane.rootProcessId })
    }
  }
}

async function readTargetRoot(
  controller: ListingController,
  ptyId: string,
  expectedIncarnationId: string | undefined
): Promise<number | 'replaced' | null> {
  const target = (
    await controller.listProcesses?.(LOCAL_EXECUTION_HOST_ID, {
      ptyIds: [ptyId],
      targetOwnerOnly: true
    })
  )?.find((pane) => pane.id === ptyId)
  if (
    expectedIncarnationId &&
    target?.incarnationId &&
    target.incarnationId !== expectedIncarnationId
  ) {
    return 'replaced'
  }
  return target?.rootProcessId ?? null
}
