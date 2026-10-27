import { describe, expect, it } from 'vitest'
import { agentBrowserWaitArguments } from './agent-browser-wait-arguments'

describe('agentBrowserWaitArguments', () => {
  it.each([
    [
      { fn: 'window.ready', timeout: 60_000 },
      ['wait', '--fn', 'window.ready', '--timeout', '60000'],
      60_000,
      65_000
    ],
    [{ selector: '#done' }, ['wait', '#done', '--timeout', '25000'], 25_000, 30_000],
    [{ timeout: 40_000 }, ['wait', '40000'], undefined, undefined]
  ])('builds %j', (options, args, conditionTimeoutMs, processTimeoutMs) => {
    expect(agentBrowserWaitArguments(options)).toEqual({
      args,
      conditionTimeoutMs,
      processTimeoutMs
    })
  })
})
