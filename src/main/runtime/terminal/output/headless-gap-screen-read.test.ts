import { expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID as PTY_ID
} from '../wait/agent-transcript-pane-test-harness'

// A model-owned screen whose rebuild capture is held by fake timers, or never lands.
async function recoveringPane(
  recoveryFrame?: { seq: number; synchronizedOutput?: boolean },
  beforeGap = 'before gap\r\n'
) {
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
  pane.runtime.onPtyData(PTY_ID, beforeGap, 1)
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
  const { runtime, handle } = await recoveringPane({ seq: 1_000 })
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
  const { runtime, handle } = await recoveringPane({ seq: 1_000, synchronizedOutput: true })
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

it('answers a blank screen cleared before the gap as a blank frame, not the transcript', async () => {
  const { runtime, handle } = await recoveringPane(undefined, 'old prompt\r\n\x1b[2J\x1b[H')
  try {
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.source).toBe('screen-stale')
    expect(read.tail).toEqual([])
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(PTY_ID, 0)
  }
})

it('drops a kept frame once a re-anchor makes its position incomparable', async () => {
  const { runtime, handle } = await recoveringPane({ seq: 1_000 })
  try {
    await vi.waitFor(async () => {
      expect((await runtime.readTerminal(handle, { screen: true })).source).toBe('screen')
    })
    // The provider's count moves: the frame's mapped position no longer says where it stands.
    runtime.anchorProviderSequence(PTY_ID, 30, 2_030)
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.source).toBe('screen-unavailable')
  } finally {
    vi.useRealTimers()
    await runtime.onPtyExit(PTY_ID, 0)
  }
})

// A provider-owned screen keeps main's provider evidence while the kept model rebuilds.
async function providerOwnedRecoveringPane(providerScreen: {
  alternateScreen: boolean
  synchronizedOutput?: () => boolean
}) {
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
        alternateScreen: providerScreen.alternateScreen,
        ...(providerScreen.synchronizedOutput?.() ? { synchronizedOutput: true } : {})
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

it('keeps a caught-up synchronized frame stale until the frame closes', async () => {
  let frameOpen = true
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    data: '',
    serializeProviderBuffer: async () => ({
      data: frameOpen ? '\x1b[H\x1b[2JHALF' : '\x1b[H\x1b[2JCOMPLETE',
      cols: 80,
      rows: 24,
      source: 'headless' as const,
      seq: pane.runtime.getPtyOutputSequence(PTY_ID),
      synchronizedOutput: frameOpen
    })
  })
  try {
    pane.runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    pane.runtime.anchorProviderSequence(PTY_ID, 0, 0)
    pane.runtime.onPtyData(PTY_ID, 'BEFORE\r\n', 1)
    pane.runtime.notePtyDataGap(PTY_ID, 9)
    await vi.waitFor(async () => {
      const read = await pane.runtime.readTerminal(pane.handle, { screen: true })
      expect(read.source).toBe('screen-stale')
      expect(read.tail).toEqual(['BEFORE'])
    })
    frameOpen = false
    pane.runtime.onPtyData(PTY_ID, '\x1b[H\x1b[2JCOMPLETE\x1b[?2026l', 2)
    await vi.waitFor(
      async () => {
        const read = await pane.runtime.readTerminal(pane.handle, { screen: true })
        expect(read.source).toBe('screen')
        expect(read.tail).toEqual(['COMPLETE'])
      },
      { timeout: 5000 }
    )
  } finally {
    await pane.runtime.onPtyExit(PTY_ID, 0)
  }
})

it.each([false, true])(
  'never answers a provider-owned recovering screen from a half-drawn provider frame (alternate=%s)',
  async (alternateScreen) => {
    let frameOpen = true
    const { runtime, handle } = await providerOwnedRecoveringPane({
      alternateScreen,
      synchronizedOutput: () => frameOpen
    })
    try {
      // Every provider read lands at once, so the refusal is the answer and not a pending capture.
      await new Promise((resolve) => setImmediate(resolve))
      const read = await runtime.readTerminal(handle, { screen: true })
      expect(read.source).toBe('screen-unavailable')
      expect(read.tail).not.toContain('provider screen')
      if (alternateScreen) {
        expect((await runtime.showTerminal(handle)).preview).not.toBe('provider screen')
      }
      // Control: once the provider's frame is whole, it answers again after the retry pause.
      frameOpen = false
      await vi.waitFor(
        async () => {
          const whole = await runtime.readTerminal(handle, { screen: true })
          expect(whole.source).toBe('screen')
          expect(whole.tail).toEqual(['provider screen'])
        },
        { timeout: 3000 }
      )
    } finally {
      await runtime.onPtyExit(PTY_ID, 0)
    }
  }
)
