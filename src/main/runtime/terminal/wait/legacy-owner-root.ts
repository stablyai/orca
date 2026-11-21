import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'

/** An old local owner's root for one terminal, unless the owner now runs another incarnation there. */
export async function readTargetRootPid(
  controller: Pick<RuntimePtyController, 'listProcesses'>,
  ptyId: string,
  expectedIncarnationId: string | undefined
): Promise<number | undefined> {
  const target = (
    await controller.listProcesses?.(LOCAL_EXECUTION_HOST_ID, {
      ptyIds: [ptyId],
      targetOwnerOnly: true
    })
  )?.find((pane) => pane.id === ptyId)
  return expectedIncarnationId &&
    target?.incarnationId &&
    target.incarnationId !== expectedIncarnationId
    ? undefined
    : target?.rootProcessId
}
