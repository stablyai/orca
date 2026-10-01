import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

const working = { agentType: 'omp', state: 'working', prompt: 'new turn' }

describe('OMP retired-pane remote ingress', () => {
  it('recovers a legacy source-less OMP new turn using validated payload identity', () => {
    const server = new AgentHookServer()
    server.retirePaneAuthority(PANE)
    server.ingestRemote(
      { paneKey: PANE, hookEventName: 'before_agent_start', payload: working },
      'ssh'
    )
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        observation: expect.objectContaining({ boundary: true })
      })
    ])
  })

  it.each([
    { payload: { ...working, state: 'invalid' } },
    { payload: { ...working, agentType: 'claude' } },
    { isReplay: 'true' },
    { isReplay: null },
    { launchToken: 42 },
    { providerSessionOnly: true }
  ])('rejected metadata leaves retirement intact: %j', (invalid) => {
    const server = new AgentHookServer()
    server.retirePaneAuthority(PANE)
    const input = {
      paneKey: PANE,
      source: 'omp',
      hookEventName: 'before_agent_start',
      payload: working,
      ...invalid
    }
    // Exercise raw JSON ingress, including malformed fields a typed caller cannot create.
    server.ingestRemote(JSON.parse(JSON.stringify(input)), 'ssh')
    expect(server.getStatusSnapshot()).toEqual([])
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'omp',
        hookEventName: 'agent_end',
        payload: { ...working, state: 'done' }
      },
      'ssh'
    )
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('a replay cannot restore a retired OMP pane', () => {
    const server = new AgentHookServer()
    server.retirePaneAuthority(PANE)
    server.ingestRemote(
      { paneKey: PANE, hookEventName: 'before_agent_start', isReplay: true, payload: working },
      'ssh'
    )
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
