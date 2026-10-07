import { HeadlessEmulator } from '../daemon/headless-emulator'
import type {
  HeadlessModelCheckpoint,
  HeadlessModelConfiguration
} from '../daemon/headless-model-checkpoint'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'

type RuntimeHeadlessModelCaptureOwner = {
  queueBoundary: Promise<void>
  source: RuntimeHeadlessTerminal
  emulator: HeadlessEmulator
  ownsSource: () => boolean
}

export class RuntimeHeadlessModelCapture {
  private owner: RuntimeHeadlessModelCaptureOwner | null

  constructor(
    readonly checkpoint: HeadlessModelCheckpoint,
    readonly outputSequence: number,
    queueBoundary: Promise<void>,
    source: RuntimeHeadlessTerminal,
    emulator: HeadlessEmulator,
    ownsSource: () => boolean
  ) {
    this.owner = { queueBoundary, source, emulator, ownsSource }
  }

  private currentOwner(): RuntimeHeadlessModelCaptureOwner {
    this.checkpoint.checkCurrent()
    if (!this.owner) {
      throw new Error('Terminal model capture is disposed')
    }
    return this.owner
  }

  get source(): RuntimeHeadlessTerminal {
    return this.currentOwner().source
  }

  get queueBoundary(): Promise<void> {
    return this.currentOwner().queueBoundary
  }

  checkCurrent(): void {
    const owner = this.currentOwner()
    if (
      !owner.ownsSource() ||
      owner.source.modelOperationFailed === true ||
      owner.source.emulator !== owner.emulator ||
      owner.source.outputSequence !== this.outputSequence
    ) {
      throw new Error('Terminal model changed after capture')
    }
  }

  dispose(): void {
    try {
      this.checkpoint.dispose()
    } finally {
      this.owner = null
    }
  }
}

export function captureRuntimeHeadlessModel(
  state: RuntimeHeadlessTerminal,
  maxBytes: number,
  isCurrent: () => boolean
): Promise<RuntimeHeadlessModelCapture | null> {
  const emulator = state.emulator
  const ownsSource = (): boolean =>
    isCurrent() && state.emulator === emulator && state.modelOperationFailed !== true
  const completion = state.writeChain.then(async () => {
    if (!ownsSource()) {
      return null
    }
    await state.ownership.settle()
    if (!ownsSource()) {
      return null
    }
    const checkpoint = emulator.captureModelCheckpoint(maxBytes)
    if (!ownsSource()) {
      checkpoint.dispose()
      return null
    }
    return new RuntimeHeadlessModelCapture(
      checkpoint,
      state.outputSequence,
      boundary,
      state,
      emulator,
      ownsSource
    )
  })
  const boundary = completion.then(
    () => {},
    () => {}
  )
  state.writeChain = boundary
  return completion
}

export function publishRuntimeHeadlessModel(
  state: RuntimeHeadlessTerminal,
  capture: RuntimeHeadlessModelCapture,
  construct: (configuration: HeadlessModelConfiguration) => HeadlessEmulator,
  isCurrent: () => boolean
): Promise<HeadlessEmulator> {
  // Any intervening queue operation can change cells without advancing the byte sequence.
  if (state !== capture.source || state.writeChain !== capture.queueBoundary) {
    return Promise.reject(new Error('Terminal model changed after capture'))
  }
  const completion = state.writeChain.then(async () => {
    const check = (): void => {
      capture.checkCurrent()
      if (!isCurrent() || state.writeChain !== boundary) {
        throw new Error('Terminal model changed during preparation')
      }
    }
    check()
    const staged = await HeadlessEmulator.prepareModelCheckpoint(capture.checkpoint, {
      construct,
      isCurrent: () => {
        check()
        return true
      }
    })
    try {
      check()
      const retired = state.emulator
      state.emulator = staged
      return retired
    } catch (error) {
      staged.dispose()
      throw error
    }
  })
  const boundary = completion.then(
    () => {},
    () => {}
  )
  state.writeChain = boundary
  return completion
}
