import { randomUUID } from 'node:crypto'
import { isUntypedTerminalInput } from '../../../../shared/terminal/input/terminal-untyped-input'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { OrcaRuntimeService } from '../../orca-runtime'

type InputEvent = { handle?: string; ptyId?: string; receiptId: string; submitKeyOnly: boolean }
export type PipelineV2InputOwner = Pick<OrcaRuntimeService, 'getRuntimeId'>
const observers = new WeakMap<PipelineV2InputOwner, (event: InputEvent) => void>()
export function registerPipelineV2InputObserver(
  runtime: PipelineV2InputOwner,
  observer: (event: InputEvent) => void
): () => void {
  observers.set(runtime, observer)
  return () => {
    observers.delete(runtime)
  }
}
export function emitPipelineV2AcceptedInput(
  runtime: PipelineV2InputOwner,
  identity: { handle?: string; ptyId?: string },
  kind: TerminalInputKind,
  accepted: boolean,
  data: string
): void {
  if (accepted && kind === 'driving' && data.length > 0 && !isUntypedTerminalInput(data)) {
    observers.get(runtime)?.({
      ...identity,
      receiptId: randomUUID(),
      submitKeyOnly: data === '\r' || data === '\n' || data === '\r\n'
    })
  }
}
