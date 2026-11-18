import { describe, expect, it } from 'vitest'
import { ZotzAgentMemorySampler, type ZotzLiveAgentPane } from './zotz-agent-memory-sampler'

describe('ZotzAgentMemorySampler', () => {
  it('keeps each run’s peak and reports it once the agent terminal is gone', async () => {
    let panes: ZotzLiveAgentPane[] = [
      { paneKey: 'p1', agent: 'claude' },
      { paneKey: 'p2', agent: 'codex' }
    ]
    let measured = new Map([
      ['p1', 1_000],
      ['p2', 500]
    ])
    const sampler = new ZotzAgentMemorySampler({
      listAgentPanes: () => panes,
      measurePanes: async () => measured,
      now: () => 0
    })

    await sampler.sample()
    measured = new Map([
      ['p1', 3_000],
      ['p2', 400]
    ])
    const second = await sampler.sample()
    expect(second.agents.find((agent) => agent.paneKey === 'p1')?.peakBytes).toBe(3_000)
    expect(second.finished).toEqual([])

    measured = new Map([['p2', 450]])
    panes = [{ paneKey: 'p2', agent: 'codex' }]
    const third = await sampler.sample()
    expect(third.finished).toEqual([{ agent: 'claude', peakBytes: 3_000 }])
    expect(third.agents.map((agent) => [agent.paneKey, agent.peakBytes])).toEqual([['p2', 500]])
  })
})
