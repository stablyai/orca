import { expect, it, vi } from 'vitest'

const runProcessMock = vi.fn()
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
}))

import { sweepOrphanedAgentBrowserSessions } from './agent-browser-orphan-sweep'

type ProcessSpec = { args?: readonly string[] }

it('reports only sessions whose close command succeeded', async () => {
  runProcessMock.mockImplementation((spec: ProcessSpec) => {
    if (spec.args?.[0] === 'session') {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          data: {
            sessions: [
              'orca-tab-ok',
              'orca-tab-exit',
              'orca-tab-timeout',
              'orca-tab-throw',
              'orca-tab-after'
            ]
          }
        }),
        stderr: '',
        timedOut: false
      })
    }
    if (spec.args?.[1] === 'orca-tab-throw') {
      return Promise.reject(new Error('spawn failed'))
    }
    return Promise.resolve({
      code: spec.args?.[1] === 'orca-tab-exit' ? 1 : 0,
      stdout: '',
      stderr: '',
      timedOut: spec.args?.[1] === 'orca-tab-timeout'
    })
  })

  const closed = await sweepOrphanedAgentBrowserSessions({
    binaryPath: '/opt/orca/agent-browser',
    env: {},
    ownsSocketDirectory: true
  })

  expect(closed).toEqual(['orca-tab-ok', 'orca-tab-after'])
})
