import { expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID as PTY_ID
} from '../wait/agent-transcript-pane-test-harness'

// A model-owned screen whose rebuild capture is held by fake timers, or never lands.
async function recoveringPane(recoveryFrame?: { seq: number; synchronizedOutput?: boolean }) {
  let recoveryAsked = (): void => {}
  const asked = new Promise<void>((resolve) => {
    recoveryAsked = resolve
  })
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    data: '',
    serializeProviderBuffer: () => {
      recoveryAsked()
      return recoveryFrame
        ? Promise.resolve({
            data: '\x1b[H\x1b[2Jprovider screen',
            cols: 80,
            rows: 24,
            source: 'headless' as const,
            ...recoveryFrame
          })
        : // The daemon is saturated: no capture it is asked for lands.
          new Promise<never>(() => {})
    }
  })
  // A read that waits on the daemon then never reaches its timeout fallback; a rebuild ahead of output never catches up.
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  pane.runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
  pane.runtime.anchorProviderSequence(PTY_ID, 0, 0)
  pane.runtime.onPtyData(PTY_ID, 'before gap\r\n', 1)
  pane.runtime.notePtyDataGap(PTY_ID, 9)
  await asked
  pane.runtime.onPtyData(PTY_ID, 'after gap', 2)
  return pane
}

it('answers a screen read at once from the last frame before the gap while a busy daemon holds the rebuild', async () => {
  const { runtime, handle } = await recoveringPane()
  try {
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.source).toBe('screen-stale')
    expect(read.tail).toEqual(['before gap'])
    expect(read.screenCapturedAt).toEqual(expect.any(Number))
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(PTY_ID, 0)
  }
})

it('answers a landed recovery frame that cannot rebuild yet as the current screen', async () => {
  // Ahead of the output parsed here, so the rebuild waits for bytes that never arrive.
  const { runtime, handle } = await recoveringPane({ seq: 5 })
  try {
    const read = await vi.waitFor(async () => {
      const screen = await runtime.readTerminal(handle, { screen: true })
      expect(screen.source).toBe('screen')
      return screen
    })
    expect(read.tail).toEqual(['provider screen'])
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(PTY_ID, 0)
  }
})

it('keeps the last whole frame when the landed recovery frame is half-drawn', async () => {
  const { runtime, handle } = await recoveringPane({ seq: 5, synchronizedOutput: true })
  try {
    // Every microtask has run: the landed frame was offered before this read.
    await new Promise((resolve) => setImmediate(resolve))
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.source).toBe('screen-stale')
    expect(read.tail).toEqual(['before gap'])
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
