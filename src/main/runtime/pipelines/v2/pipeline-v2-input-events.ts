import { randomUUID } from 'node:crypto'
import { isUntypedTerminalInput } from '../../../../shared/terminal/input/terminal-untyped-input'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { OrcaRuntimeService } from '../../orca-runtime'

type InputEvent = {
  handle?: string
  ptyId?: string
  receiptId: string
  submitKeyOnly: boolean
  uncertainDelivery: true
}
export type PipelineV2InputOwner = Pick<OrcaRuntimeService, 'getRuntimeId'>
const observers = new WeakMap<PipelineV2InputOwner, (event: InputEvent) => void | Promise<void>>()
export function registerPipelineV2InputObserver(
  runtime: PipelineV2InputOwner,
  observer: (event: InputEvent) => void | Promise<void>
): () => void {
  observers.set(runtime, observer)
  return () => {
    observers.delete(runtime)
  }
}
export function preparePipelineV2Input(
  runtime: PipelineV2InputOwner,
  identity: { handle?: string; ptyId?: string },
  kind: TerminalInputKind,
  data: string
): void | Promise<void> {
  if (kind === 'driving' && data.length > 0 && !isUntypedTerminalInput(data)) {
    return observers.get(runtime)?.({
      ...identity,
      receiptId: randomUUID(),
      uncertainDelivery: true,
      submitKeyOnly: data === '\r' || data === '\n' || data === '\r\n'
    })
  }
}
