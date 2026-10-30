// Headless serve has no window listener; hook-derived ready titles must still settle the runtime tracker.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type EnrichedListener = (event: Parameters<typeof driveSyntheticTitleFromHookStatus>[0]) => void

const hooks = vi.hoisted(() => {
  const enriched: EnrichedListener[] = []
  return { enriched, ingest: vi.fn(), trackedTitle: vi.fn((): string | null => null) }
})

vi.mock('../ipc/pty/pane/key-state', () => ({
  registerPaneKeyTeardownListener: vi.fn(),
  getPtyIdForPaneKey: (paneKey: string) => (paneKey === 'pane-1' ? 'pty-1' : null)
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribePaneStatusClear: vi.fn(),
    subscribeStatusDrop: vi.fn(),
    subscribeEnrichedStatus: (listener: EnrichedListener) => {
      hooks.enriched.push(listener)
      return () => {}
    }
  }
}))

import {
  driveSyntheticTitleFromHookStatus,
  initializeSyntheticTitleRuntime
} from './synthetic-title-runtime'
import { mainProcessState } from './main-process-state'

function hermesStatus(state: 'working' | 'done'): Parameters<EnrichedListener>[0] {
  return { paneKey: 'pane-1', payload: { state, agentType: 'hermes' } }
}

beforeEach(() => {
  hooks.enriched.length = 0
  hooks.ingest.mockReset()
  hooks.trackedTitle.mockReset()
  mainProcessState.mainWindow = null
  mainProcessState.store = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the producer reads only these two members of the runtime.
  mainProcessState.runtime = {
    ingestSyntheticTitleFrame: hooks.ingest,
    getTrackedPtyTitle: hooks.trackedTitle
  } as unknown as typeof mainProcessState.runtime
})

describe('synthetic agent titles without a window', () => {
  it('feeds the runtime title tracker from the hook store subscription', () => {
    initializeSyntheticTitleRuntime()
    expect(hooks.enriched).toHaveLength(1)

    hooks.enriched[0](hermesStatus('done'))

    expect(hooks.ingest).toHaveBeenCalledTimes(1)
    expect(hooks.ingest.mock.calls[0][0]).toBe('pty-1')
    expect(hooks.ingest.mock.calls[0][1]).toContain('Hermes ready')
  })

  // Stale ready titles outrank new working status and falsely satisfy tui-idle mid-turn.
  it('replaces the ready title with a working one when the next turn starts', () => {
    driveSyntheticTitleFromHookStatus(hermesStatus('done'))
    driveSyntheticTitleFromHookStatus(hermesStatus('working'))

    expect(hooks.ingest).toHaveBeenCalledTimes(2)
    expect(hooks.ingest.mock.calls[1][1]).toContain('Hermes')
    expect(hooks.ingest.mock.calls[1][1]).not.toContain('ready')
  })

  it('skips identity-only refreshes and structured rows', () => {
    driveSyntheticTitleFromHookStatus({ ...hermesStatus('done'), providerSessionOnly: true })
    driveSyntheticTitleFromHookStatus({ ...hermesStatus('done'), structuredHost: 'owned' })

    expect(hooks.ingest).not.toHaveBeenCalled()
  })

  // Codex leaves working titles to itself, so a Codex that paints none kept "ready" all turn.
  it.each([
    { title: 'Codex ready', retracted: true },
    { title: 'Codex - action required', retracted: true },
    { title: '⠋ Fix the build | orca', retracted: false }
  ])(
    'retracts only its own rest label when Codex starts a turn ($title)',
    ({ title, retracted }) => {
      hooks.trackedTitle.mockReturnValue(title)
      driveSyntheticTitleFromHookStatus({
        paneKey: 'pane-1',
        payload: { state: 'working', agentType: 'codex' }
      })

      expect(hooks.ingest.mock.calls.map(([, frame]) => frame)).toEqual(
        retracted ? ['\x1b]0;⠋ Codex\x07'] : []
      )
    }
  )
})
