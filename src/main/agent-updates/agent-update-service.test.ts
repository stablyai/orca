import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentUpdateRow } from '../../shared/agent-updates/agent-update-types'
import type { AgentUpdateSettings } from './check-agent-updates'

const { checkAgentUpdates, runAgentUpdate } = vi.hoisted(() => ({
  checkAgentUpdates: vi.fn(),
  runAgentUpdate: vi.fn()
}))
vi.mock('./check-agent-updates', () => ({ checkAgentUpdates }))
vi.mock('./run-agent-update', () => ({ runAgentUpdate }))

const SETTINGS: AgentUpdateSettings = { disabledTuiAgents: [], agentCmdOverrides: {} }
const readSettings = () => SETTINGS
const START = new Date('2026-11-09T09:00:00Z')

function row(agent: 'claude' | 'codex', current: string, latest: string): AgentUpdateRow {
  return { agent, current, latest, updateAvailable: true, action: { kind: 'run' }, run: null }
}

function checked(rows: AgentUpdateRow[]) {
  return { rows, sourcesReachable: true }
}

// Why: the service keeps module-level state, so each case loads a fresh copy.
async function loadService() {
  vi.resetModules()
  return import('./agent-update-service')
}

describe('agent-update-service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    checkAgentUpdates.mockReset()
    runAgentUpdate.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('marks the agent running, then done with the new version as current', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValue(checked([row('claude', '2.1.319', '2.1.320')]))
    runAgentUpdate.mockResolvedValue({ status: 'done', version: '2.1.320' })
    await service.refreshAgentUpdates(SETTINGS)
    const seen: string[] = []
    service.onAgentUpdatesChanged((state) => seen.push(String(state.rows[0].run?.state)))

    await service.startAgentUpdates(['claude'], readSettings)

    expect(seen).toEqual(['running', 'done'])
    expect(runAgentUpdate).toHaveBeenCalledWith('claude', '2.1.319', SETTINGS)
    expect(service.getAgentUpdatesState().rows).toEqual([
      {
        agent: 'claude',
        current: '2.1.320',
        latest: '2.1.320',
        updateAvailable: false,
        action: { kind: 'run' },
        run: { state: 'done' }
      }
    ])
  })

  it('drops done rows on the next refresh and keeps failed rows until up to date', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValue(
      checked([row('claude', '2.1.319', '2.1.320'), row('codex', '0.165.0', '0.166.0')])
    )
    runAgentUpdate.mockImplementation(async (agent: string) =>
      agent === 'claude'
        ? { status: 'done', version: '2.1.320' }
        : { status: 'failed', message: 'EACCES' }
    )
    await service.refreshAgentUpdates(SETTINGS)
    await service.startAgentUpdates(['claude', 'codex'], readSettings)

    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'))
    const cached = await service.refreshAgentUpdates(SETTINGS)

    expect(checkAgentUpdates).toHaveBeenCalledTimes(1)
    expect(cached.rows).toEqual([
      { ...row('codex', '0.165.0', '0.166.0'), run: { state: 'failed', message: 'EACCES' } }
    ])

    checkAgentUpdates.mockResolvedValue(checked([]))
    vi.setSystemTime(new Date('2026-11-09T15:00:01Z'))
    const rechecked = await service.refreshAgentUpdates(SETTINGS)

    expect(checkAgentUpdates).toHaveBeenCalledTimes(2)
    expect(rechecked.rows).toEqual([])
  })

  it('does not revive an updated agent from a check that read the old version', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValueOnce(checked([row('claude', '2.1.319', '2.1.320')]))
    runAgentUpdate.mockResolvedValue({ status: 'done', version: '2.1.320' })
    await service.refreshAgentUpdates(SETTINGS)
    vi.setSystemTime(new Date('2026-11-09T15:00:01Z'))
    let finishCheck: (result: ReturnType<typeof checked>) => void = () => {}
    checkAgentUpdates.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCheck = resolve
      })
    )

    const overlappingCheck = service.refreshAgentUpdates(SETTINGS)
    await service.startAgentUpdates(['claude'], readSettings)
    finishCheck(checked([row('claude', '2.1.319', '2.1.320')]))
    await overlappingCheck

    expect(service.getAgentUpdatesState().rows).toEqual([
      {
        agent: 'claude',
        current: '2.1.320',
        latest: '2.1.320',
        updateAvailable: false,
        action: { kind: 'run' },
        run: { state: 'done' }
      }
    ])
  })

  it('keeps working when a listener throws on every notification', async () => {
    const service = await loadService()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    checkAgentUpdates.mockResolvedValue(checked([row('claude', '2.1.319', '2.1.320')]))
    runAgentUpdate.mockResolvedValue({ status: 'done', version: '2.1.320' })
    service.onAgentUpdatesChanged(() => {
      throw new Error('renderer gone')
    })

    const state = await service.refreshAgentUpdates(SETTINGS)
    await service.startAgentUpdates(['claude'], readSettings)

    expect(state.checking).toBe(false)
    expect(service.getAgentUpdatesState().rows[0].run).toEqual({ state: 'done' })
  })

  it('waits an hour before checking again when no release source was reachable', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValue({ rows: [], sourcesReachable: false })
    const offline = await service.refreshAgentUpdates(SETTINGS)

    vi.setSystemTime(new Date('2026-11-09T09:30:00Z'))
    await service.refreshAgentUpdates(SETTINGS)
    expect(checkAgentUpdates).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-11-09T10:00:01Z'))
    await service.refreshAgentUpdates(SETTINGS)

    expect(offline.checkedAt).toBeNull()
    expect(checkAgentUpdates).toHaveBeenCalledTimes(2)
  })

  it('checks again when an agent is disabled inside the cache window', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValueOnce(
      checked([row('claude', '2.1.319', '2.1.320'), row('codex', '0.165.0', '0.166.0')])
    )
    await service.refreshAgentUpdates(SETTINGS)
    const disabledCodex: AgentUpdateSettings = { ...SETTINGS, disabledTuiAgents: ['codex'] }
    checkAgentUpdates.mockResolvedValueOnce(checked([row('claude', '2.1.319', '2.1.320')]))

    vi.setSystemTime(new Date('2026-11-09T09:05:00Z'))
    const state = await service.refreshAgentUpdates(disabledCodex)

    expect(checkAgentUpdates).toHaveBeenCalledTimes(2)
    expect(checkAgentUpdates).toHaveBeenLastCalledWith(disabledCodex)
    expect(state.rows.map((entry) => entry.agent)).toEqual(['claude'])
  })

  it('checks again after a running check that read the old settings', async () => {
    const service = await loadService()
    let finishFirst: (result: ReturnType<typeof checked>) => void = () => {}
    checkAgentUpdates.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve
      })
    )
    const disabledCodex: AgentUpdateSettings = { ...SETTINGS, disabledTuiAgents: ['codex'] }
    const first = service.refreshAgentUpdates(SETTINGS)
    checkAgentUpdates.mockResolvedValueOnce(checked([row('claude', '2.1.319', '2.1.320')]))

    const second = service.refreshAgentUpdates(disabledCodex)
    finishFirst(checked([row('claude', '2.1.319', '2.1.320'), row('codex', '0.165.0', '0.166.0')]))
    await first
    const state = await second

    expect(checkAgentUpdates).toHaveBeenCalledTimes(2)
    expect(state.rows.map((entry) => entry.agent)).toEqual(['claude'])
  })

  it('does not update an agent that was disabled after its row appeared', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValue(checked([row('claude', '2.1.319', '2.1.320')]))
    await service.refreshAgentUpdates(SETTINGS)

    await service.startAgentUpdates(['claude'], () => ({
      ...SETTINGS,
      disabledTuiAgents: ['claude']
    }))

    expect(runAgentUpdate).not.toHaveBeenCalled()
    expect(service.getAgentUpdatesState().rows).toEqual([])
  })

  it('skips a queued update when its agent is disabled before its turn', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValue(
      checked([row('claude', '2.1.319', '2.1.320'), row('codex', '0.165.0', '0.166.0')])
    )
    await service.refreshAgentUpdates(SETTINGS)
    let settings = SETTINGS
    runAgentUpdate.mockImplementation(async () => {
      settings = { ...SETTINGS, disabledTuiAgents: ['codex'] }
      return { status: 'done', version: '2.1.320' }
    })

    await service.startAgentUpdates(['claude', 'codex'], () => settings)

    expect(runAgentUpdate).toHaveBeenCalledTimes(1)
    expect(service.getAgentUpdatesState().rows.map((entry) => entry.agent)).toEqual(['claude'])
  })

  it('returns the state when the check rejects', async () => {
    const service = await loadService()
    checkAgentUpdates.mockRejectedValue(new Error('detection failed'))

    const state = await service.refreshAgentUpdates(SETTINGS)

    expect(state).toEqual({ rows: [], checking: false, checkedAt: null })
  })
})
