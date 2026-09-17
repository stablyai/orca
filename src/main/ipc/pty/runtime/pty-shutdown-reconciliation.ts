import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import { ptyIncarnationById } from '../provider/ownership-state'

type FinishPtyShutdown = (
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined
) => string | undefined

/** Reconcile the lifecycle while its pane binding still exists, then clear provider state. */
export function finishPtyShutdownAfterExit(
  runtime: OrcaRuntimeService | undefined,
  finish: FinishPtyShutdown,
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined,
  code: number
): string | undefined {
  const incarnationId = ptyIncarnationById.get(id)
  runtime?.onPtyExit(id, code, incarnationId)
  return finish(id, connectionId, store) ?? incarnationId
}
