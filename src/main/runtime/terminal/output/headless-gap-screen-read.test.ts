import { expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID as PTY_ID
} from '../wait/agent-transcript-pane-test-harness'

it('answers a screen read at once while a gap rebuild waits on a busy daemon', async () => {
  let recoveryAsked = (): void => {}
  const asked = new Promise<void>((resolve) => {
    recoveryAsked = resolve
  })
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    data: '',
    // The daemon is saturated: no capture it is asked for lands.
    serializeProviderBuffer: () => {
      recoveryAsked()
      return new Promise(() => {})
    }
  })
  // A read that waits on the daemon then never reaches its timeout fallback.
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    runtime.anchorProviderSequence(PTY_ID, 0, 0)
    runtime.onPtyData(PTY_ID, 'before gap\r\n', 1)
    runtime.notePtyDataGap(PTY_ID, 9)
    await asked
    runtime.onPtyData(PTY_ID, 'after gap', 2)

    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.source).toBe('screen-unavailable')
    expect(read.tail).toEqual(['before gap', 'after gap'])
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(PTY_ID, 0)
  }
})
