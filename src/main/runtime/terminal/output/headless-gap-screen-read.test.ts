import { assert, expect, it } from 'vitest'
import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { anchorStream, createRuntime, grid } from './headless-recovery-test-harness'

const streamRead: RuntimeTerminalRead = {
  handle: 'term-gap',
  status: 'running',
  tail: [],
  truncated: false,
  nextCursor: null
}

it('answers a screen read from the live model while a gap rebuild waits on a busy daemon', async () => {
  const runtime = createRuntime()
  const ptyId = 'pty-gap-screen-read'
  let recoveryAsked: (() => void) | undefined
  const recoveryCapture = new Promise<void>((resolve) => {
    recoveryAsked = resolve
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => grid,
    // The daemon is saturated: no capture it is asked for ever lands.
    serializeProviderBuffer: () => {
      recoveryAsked?.()
      return new Promise(() => {})
    }
  })
  try {
    anchorStream(runtime, ptyId)
    runtime.onPtyData(ptyId, 'before gap\r\n', 1)
    runtime.notePtyDataGap(ptyId, 9)
    await recoveryCapture
    runtime.onPtyData(ptyId, 'after gap', 2)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService inherits this protected method with exactly this signature.
    const screen = runtime as unknown as {
      readRenderedScreen(ptyId: string, read: RuntimeTerminalRead): Promise<RuntimeTerminalRead>
    }
    // Before the fix this read queued its own capture behind recovery's and never returned.
    const read = await screen.readRenderedScreen(ptyId, streamRead)
    assert(read.source !== 'screen-unavailable')
    expect(read.tail).toEqual(['before gap', 'after gap'])
  } finally {
    await runtime.onPtyExit(ptyId, 0)
  }
})
