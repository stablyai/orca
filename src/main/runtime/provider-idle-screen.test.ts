import { describe, expect, it, vi } from 'vitest'
import { evaluateAgentStateRules } from './agent-state-rules/agent-state-rules-engine'
import { waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import {
  CAPTURED_LINES,
  createProviderIdlePane,
  observeIdleWait,
  providerSnapshot,
  PTY_ID,
  SNAPSHOT_SEQUENCE
} from './provider-idle-screen-test-fixture'

describe('quiet readiness from an authoritative provider viewport', () => {
  it.each(['pty', 'leaf'] as const)(
    'settles the captured 0.160 composer through the %s runtime wait',
    async (path) => {
      const pane = await createProviderIdlePane(path)
      const retained = pane.runtime.retainedState()
      const tail = [...pane.runtime.pty().tailBuffer]
      expect(pane.runtime.wholeScreen()).toBeNull()
      expect(pane.runtime.agent()).toBe('codex')
      expect(
        evaluateAgentStateRules('codex', { readScreenLines: () => CAPTURED_LINES })
      ).toMatchObject({
        ruleId: 'composer_ready',
        requiresQuiet: true
      })

      await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject({
        condition: 'tui-idle',
        satisfied: true
      })

      expect(pane.serializeProviderBuffer).toHaveBeenCalledTimes(1)
      expect(pane.serializeProviderBuffer).toHaveBeenCalledWith(PTY_ID, { scrollbackRows: 0 })
      expect(pane.runtime.retainedState()).toMatchObject({
        model: retained.model,
        hydration: retained.hydration,
        providerPreferred: true
      })
      expect(pane.runtime.pty().tailBuffer).toEqual(tail)
      expect(pane.runtime.wholeScreen()).toBeNull()
      expect(pane.runtime.pendingResources()).toEqual({
        waiters: 0,
        timers: 0,
        visibleReads: 0,
        acquisitions: 0,
        scans: 0
      })
    }
  )

  it.each([false, true])(
    'reads an authoritative viewport in alternate mode %s',
    async (alternate) => {
      const serializeProviderBuffer = vi.fn(async () => providerSnapshot(CAPTURED_LINES, alternate))
      const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
      // Establish the provider mode before the wait; a normal-buffer suffix is still partial.
      await pane.runtime.captureProvider()
      serializeProviderBuffer.mockClear()
      await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject({ satisfied: true })
      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
      expect(pane.runtime.retainedState().providerPreferred).toBe(true)
    }
  )

  it.each(['missing', 'pending'] as const)(
    'reads the provider when the whole model is %s',
    async (mode) => {
      const pane = await createProviderIdlePane()
      if (mode === 'missing') {
        pane.runtime.removeModel()
      } else {
        pane.runtime.pendingHydration(false)
      }
      const retained = pane.runtime.retainedState()
      await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject({ satisfied: true })
      expect(pane.runtime.retainedState()).toMatchObject({
        model: retained.model,
        hydration: retained.hydration,
        providerPreferred: retained.providerPreferred
      })
      expect(pane.runtime.wholeScreen()).toBeNull()
    }
  )

  it('uses the continued provider sequence without promoting the retained suffix', async () => {
    const pane = await createProviderIdlePane()
    pane.runtime.synchronizePtyOutputSequenceFromProvider(
      PTY_ID,
      {
        value: SNAPSHOT_SEQUENCE,
        generation: 'continued'
      },
      pane.runtime.getPtyOutputSequence(PTY_ID)
    )
    await pane.runtime.model().writeChain
    await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject({ satisfied: true })
    expect(pane.runtime.wholeScreen()).toBeNull()
    expect(pane.runtime.retainedState().providerPreferred).toBe(true)
  })

  it('waits for quiescence before acquiring a provider frame', async () => {
    const pane = await createProviderIdlePane()
    pane.runtime.pty().lastOutputAt = Date.now()
    pane.runtime.leaf().lastOutputAt = Date.now()
    const wait = observeIdleWait(pane)
    await vi.advanceTimersByTimeAsync(2999)
    expect(pane.serializeProviderBuffer).not.toHaveBeenCalled()
    expect(wait.outcome()).toBeNull()
    await vi.advanceTimersByTimeAsync(1200)
    expect(wait.outcome()).toMatchObject({ satisfied: true })
    expect(pane.serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('refuses a busy provider composer without serializing unchanged output every poll', async () => {
    const composer = CAPTURED_LINES.findIndex((line) => line.startsWith('›'))
    const busy = [
      ...CAPTURED_LINES.slice(0, composer),
      '• Working (3s • esc to interrupt)',
      ...CAPTURED_LINES.slice(composer)
    ]
    const serializeProviderBuffer = vi.fn(async () => providerSnapshot(busy))
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    await expect(waitForTranscriptIdle(pane, 8000)).rejects.toThrow('timeout')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
  })

  it('never substitutes a ready partial headless grid for a missing provider during hydration', async () => {
    const serializeProviderBuffer = vi.fn(async () => null)
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    await pane.runtime.model().emulator.write('› Ask Codex to do anything\r\n? for shortcuts')
    pane.runtime.pendingHydration(false)
    expect(pane.runtime.model().emulator.getVisibleLines().join('\n')).toContain('Ask Codex')
    await expect(waitForTranscriptIdle(pane, 8000)).rejects.toThrow('timeout')
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(pane.runtime.retainedState()).toMatchObject({
      model: true,
      hydration: 'pending',
      providerPreferred: false
    })
  })

  it('restores a projected unsent draft before classifying the composer', async () => {
    const snapshot = providerSnapshot([
      '\x1b[1m›\x1b[22m keep this unsent note',
      '',
      'gpt-6.1-sol · ~/repo'
    ])
    snapshot.data += '\x1b[1;23H'
    const serializeProviderBuffer = vi.fn(async () => snapshot)
    const pane = await createProviderIdlePane('pty', { serializeProviderBuffer })
    const projection = await pane.runtime.providerViewport()
    expect(projection?.draft).toBe('keep this unsent note')
    expect(projection?.lines).toContain('›')
    expect((await pane.runtime.providerIdleScreen())?.lines).toContain('› keep this unsent note')
    await expect(waitForTranscriptIdle(pane, 8000)).rejects.toThrow('timeout')
    expect(snapshot.data).toContain('keep this unsent note')
    expect(serializeProviderBuffer).toHaveBeenCalledTimes(3)
  })

  it.each(['working', 'permission'] as const)('refuses the retained %s status', async (status) => {
    const pane = await createProviderIdlePane()
    pane.runtime.pty().lastAgentStatus = status
    await expect(waitForTranscriptIdle(pane, 8000)).rejects.toThrow('timeout')
    expect(pane.serializeProviderBuffer).not.toHaveBeenCalled()
  })

  it.each(['working', 'blocked', 'waiting'] as const)(
    'refuses fresh first-party %s evidence',
    async (state) => {
      const pane = await createProviderIdlePane()
      pane.runtime.pty().lastExplicitAgentStatus = { state, updatedAt: Date.now() }
      await expect(waitForTranscriptIdle(pane, 8000)).rejects.toThrow('timeout')
      expect(pane.serializeProviderBuffer.mock.calls.length).toBeLessThanOrEqual(1)
    }
  )

  it('keeps a blocker in the actual tail ahead of the provider composer', async () => {
    const pane = await createProviderIdlePane()
    pane.runtime.pty().tailBuffer = ['Do you trust the files in this folder?']
    await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
    expect(pane.serializeProviderBuffer).not.toHaveBeenCalled()
    expect(pane.runtime.pty().tailBuffer).toEqual(['Do you trust the files in this folder?'])
  })

  it('keeps a whole live model on the existing synchronous lane without a provider read', async () => {
    const pane = await createProviderIdlePane()
    await pane.runtime.model().emulator.write('› Ask Codex to do anything\r\n? for shortcuts')
    pane.runtime.trustWholeModel()
    expect(pane.runtime.wholeScreen()).not.toBeNull()
    await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject({ satisfied: true })
    expect(pane.serializeProviderBuffer).not.toHaveBeenCalled()
  })
})
