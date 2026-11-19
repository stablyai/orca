import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { readProcessStartTimeMs } from '../../agent-session/ownership/agent-session-process-identity-probe'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'

const MAX_REMEMBERED_ROOTS = 256
const rootByPtyId = new Map<
  string,
  { incarnationId: string; pid: number; startedAtMs: number | null }
>()

/** A local terminal's root process, or 'replaced' when the PTY is no longer the expected incarnation.
 * Why remembered: an older daemon lists every session to answer for one, and the root never changes within an incarnation. */
export async function readLegacyPtyRootProcessId(
  controller: Pick<RuntimePtyController, 'listProcesses'>,
  ptyId: string,
  expectedIncarnationId?: string
): Promise<number | 'replaced' | null> {
  const remembered = rootByPtyId.get(ptyId)
  if (remembered && remembered.incarnationId === expectedIncarnationId) {
    // Why the start time: a reused PID must not stand in for a root that exited.
    if ((await readProcessStartTimeMs(remembered.pid)) === remembered.startedAtMs) {
      return remembered.pid
    }
    rootByPtyId.delete(ptyId)
  }
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
  const pid = target?.rootProcessId
  if (!pid) {
    return null
  }
  if (expectedIncarnationId && target.incarnationId === expectedIncarnationId) {
    const startedAtMs = await readProcessStartTimeMs(pid)
    if (startedAtMs !== null) {
      rootByPtyId.delete(ptyId)
      rootByPtyId.set(ptyId, { incarnationId: expectedIncarnationId, pid, startedAtMs })
      if (rootByPtyId.size > MAX_REMEMBERED_ROOTS) {
        const oldest = rootByPtyId.keys().next()
        if (!oldest.done) {
          rootByPtyId.delete(oldest.value)
        }
      }
    }
  }
  return pid
}
