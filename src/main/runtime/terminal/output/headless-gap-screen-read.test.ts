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

// A provider-owned screen keeps main's provider evidence while the kept model rebuilds.
async function providerOwnedRecoveringPane(providerScreen: { alternateScreen: boolean }) {
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    data: '',
    serializeProviderBuffer: (_ptyId, opts) =>
      Promise.resolve({
        data: '\x1b[H\x1b[2Jprovider screen',
        cols: 80,
        rows: 24,
        // Recovery's snapshot predates its journal, so it lands and installs the mode tracker but cannot rebuild.
        seq: opts?.recovery ? 0 : pane.runtime.getPtyOutputSequence(PTY_ID),
        source: 'headless' as const,
        alternateScreen: providerScreen.alternateScreen
      })
  })
  // A continued stream no seed has settled: the provider owns its screen.
  pane.runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, {
    value: 0,
    generation: 'continued'
  })
  pane.runtime.anchorProviderSequence(PTY_ID, 0, 0)
  pane.runtime.onPtyData(PTY_ID, 'before\r\n', 1)
  pane.runtime.notePtyDataGap(PTY_ID, 9)
  return pane
}

it('answers a provider-owned normal screen from the provider while the kept model rebuilds', async () => {
  const { runtime, handle } = await providerOwnedRecoveringPane({ alternateScreen: false })
  try {
    const read = await vi.waitFor(async () => {
      const screen = await runtime.readTerminal(handle, { screen: true })
      expect(screen.source).toBe('screen')
      return screen
    })
    expect(read.tail).toEqual(['provider screen'])
  } finally {
    await runtime.onPtyExit(PTY_ID, 0)
  }
})

it('previews a provider-owned screen from the provider frame while the kept model rebuilds', async () => {
  const { runtime, handle } = await providerOwnedRecoveringPane({ alternateScreen: true })
  try {
    await vi.waitFor(async () => {
      expect((await runtime.showTerminal(handle)).preview).toBe('provider screen')
    })
  } finally {
    await runtime.onPtyExit(PTY_ID, 0)
  }
})
