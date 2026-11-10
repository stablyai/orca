import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentUpdateRow } from '../../shared/agent-updates/agent-update-types'

const { checkAgentUpdates, runAgentUpdate } = vi.hoisted(() => ({
  checkAgentUpdates: vi.fn(),
  runAgentUpdate: vi.fn()
}))
vi.mock('./check-agent-updates', () => ({ checkAgentUpdates }))
vi.mock('./run-agent-update', () => ({ runAgentUpdate }))

const SETTINGS = { disabledTuiAgents: [], agentCmdOverrides: {} }
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

    await service.startAgentUpdates(['claude'], SETTINGS)

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
    await service.startAgentUpdates(['claude', 'codex'], SETTINGS)

    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'))
    const cached = await service.refreshAgentUpdates(SETTINGS)

    expect(checkAgentUpdates).toHaveBeenCalledTimes(1)
    expect(cached.rows).toEqual([
      { ...row('codex', '0.165.0', '0.166.0'), run: { state: 'failed', message: 'EACCES' } }
    ])

    checkAgentUpdates.mockResolvedValue(checked([]))
    vi.setSystemTime(new Date('2026-11-09T13:00:01Z'))
    const rechecked = await service.refreshAgentUpdates(SETTINGS)

    expect(checkAgentUpdates).toHaveBeenCalledTimes(2)
    expect(rechecked.rows).toEqual([])
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
    await service.startAgentUpdates(['claude'], SETTINGS)

    expect(state.checking).toBe(false)
    expect(service.getAgentUpdatesState().rows[0].run).toEqual({ state: 'done' })
  })

  it('checks again inside the cache window when no release source was reachable', async () => {
    const service = await loadService()
    checkAgentUpdates.mockResolvedValue({ rows: [], sourcesReachable: false })
    const offline = await service.refreshAgentUpdates(SETTINGS)

    vi.setSystemTime(new Date('2026-11-09T09:30:00Z'))
    await service.refreshAgentUpdates(SETTINGS)

    expect(offline.checkedAt).toBeNull()
    expect(checkAgentUpdates).toHaveBeenCalledTimes(2)
  })

  it('returns the state when the check rejects', async () => {
    const service = await loadService()
    checkAgentUpdates.mockRejectedValue(new Error('detection failed'))

    const state = await service.refreshAgentUpdates(SETTINGS)

    expect(state).toEqual({ rows: [], checking: false, checkedAt: null })
  })
})
