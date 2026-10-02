import { describe, expect, it, vi } from 'vitest'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import {
  createProviderIdlePane,
  observeIdleWait,
  providerSnapshot
} from './provider-idle-screen-test-fixture'

const TRUST_SCREEN = 'Do you trust the files in this folder?'
const TRUST_RESULT = { satisfied: false, blockedReason: 'agent-trust-workspace' }

describe('provider readiness preserves rendered blockers', () => {
  it.each(['pty', 'leaf'] as const)(
    '%s still reads the rendered trust prompt when the provider is unavailable',
    async (path) => {
      const serializeProviderBuffer = vi.fn(async () => null)
      const pane = await createProviderIdlePane(path, { serializeProviderBuffer })
      await pane.runtime.model().emulator.write(TRUST_SCREEN)
      const readVisibleScreen = vi.fn()
      pane.runtime.beforeVisibleRead = readVisibleScreen
      const retained = pane.runtime.retainedState()
      const tail = [...pane.runtime.pty().tailBuffer]
      expect(pane.runtime.wholeScreen()).toBeNull()

      const wait = observeIdleWait(pane)
      await vi.advanceTimersByTimeAsync(8000)
      expect({
        outcome: await wait.settled,
        providerReads: serializeProviderBuffer.mock.calls.length,
        visibleReads: readVisibleScreen.mock.calls.length
      }).toMatchObject({ outcome: TRUST_RESULT, providerReads: 1, visibleReads: 1 })
      expect(pane.runtime.retainedState()).toMatchObject({
        model: retained.model,
        hydration: retained.hydration,
        providerPreferred: retained.providerPreferred
      })
      expect(pane.runtime.pty().tailBuffer).toEqual(tail)
    }
  )

  it.each(['pty', 'leaf'] as const)(
    '%s still reads the rendered trust prompt after a pending provider verdict',
    async (path) => {
      const serializeProviderBuffer = vi.fn(async () =>
        providerSnapshot(['Unfinished provider frame'])
      )
      const pane = await createProviderIdlePane(path, { serializeProviderBuffer })
      await pane.runtime.model().emulator.write(TRUST_SCREEN)
      const readVisibleScreen = vi.fn()
      pane.runtime.beforeVisibleRead = readVisibleScreen

      const wait = observeIdleWait(pane)
      await vi.advanceTimersByTimeAsync(8000)
      expect({
        outcome: await wait.settled,
        providerReads: serializeProviderBuffer.mock.calls.length,
        visibleReads: readVisibleScreen.mock.calls.length
      }).toMatchObject({ outcome: TRUST_RESULT, providerReads: 1, visibleReads: 1 })
    }
  )

  it.each(['pty', 'leaf'] as const)(
    '%s reports the recorded unanswered trust dialog in the provider frame',
    async (path) => {
      const serializeProviderBuffer = vi.fn(async () => ({
        ...providerSnapshot(),
        data: readRuntimeFixture('codex-0-158-0-trustprompt'),
        cols: 120,
        rows: 40
      }))
      const pane = await createProviderIdlePane(path, { serializeProviderBuffer })
      pane.runtime.removeModel()
      expect(pane.runtime.pty().tailBuffer).toEqual(['Retained redraw suffix'])

      await expect(waitForTranscriptIdle(pane, 8000)).resolves.toMatchObject(TRUST_RESULT)

      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
      expect(pane.runtime.retainedState().providerPreferred).toBe(true)
      expect(pane.runtime.pendingResources()).toEqual({
        waiters: 0,
        timers: 0,
        visibleReads: 0,
        acquisitions: 0,
        scans: 0
      })
    }
  )

  it.each([
    ['pty', 'busy'],
    ['leaf', 'busy'],
    ['pty', 'draft'],
    ['leaf', 'draft']
  ] as const)(
    'keeps the %s wait pending under a name-only title and a %s frame',
    async (path, kind) => {
      const lines =
        kind === 'busy'
          ? ['• Working (3s • esc to interrupt)', '› Ask Codex to do anything', '? for shortcuts']
          : ['› keep this unsent note', 'gpt-6.1-sol · ~/repo']
      const serializeProviderBuffer = vi.fn(async () => providerSnapshot(lines))
      const pane = await createProviderIdlePane(path, { serializeProviderBuffer })
      for (const record of [pane.runtime.pty(), pane.runtime.leaf()]) {
        record.lastAgentStatus = 'idle'
        record.lastOscTitle = 'codex'
      }

      await expect(waitForTranscriptIdle(pane, 8000)).rejects.toThrow('timeout')

      expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    }
  )
})
