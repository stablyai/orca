import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('./orchestration/terminal-identity', () => ({
  resolveOrchestrationTerminalHandle: vi.fn().mockResolvedValue('coord')
}))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClient } from '../runtime-client'

const client = new RuntimeClient('/unused-question-cli', 1000, null, null)
const call = vi.spyOn(client, 'call')
function invoke(command: string, values: Record<string, string>) {
  return ORCHESTRATION_HANDLERS[`orchestration ${command}`]({
    flags: new Map(Object.entries(values)),
    client,
    cwd: '/repo',
    json: true
  })
}
const selector = { id: 'q1', run: 'r1', task: 't1', dispatch: 'd1' }

beforeEach(() => {
  call.mockReset().mockRejectedValue(new Error('Unexpected RPC'))
})

describe('exact question CLI', () => {
  it.each([undefined, 'auto'])(
    'rejects missing or invalid reply mode (%s) before RPC',
    async (mode) => {
      await expect(
        invoke('reply', { id: 'q1', body: 'yes', ...(mode ? { mode } : {}) })
      ).rejects.toThrow()
      expect(call).not.toHaveBeenCalled()
    }
  )

  it.each(['run', 'task', 'dispatch'])(
    'rejects question replies missing %s before RPC',
    async (field) => {
      const flags: Record<string, string> = { ...selector, mode: 'question', body: 'yes' }
      delete flags[field]
      await expect(invoke('reply', flags)).rejects.toThrow(`--${field}`)
      expect(call).not.toHaveBeenCalled()
    }
  )

  it.each(['id', 'run', 'task', 'dispatch'])(
    'rejects inspect missing %s before RPC',
    async (field) => {
      const flags: Record<string, string> = { ...selector }
      delete flags[field]
      await expect(invoke('question-inspect', flags)).rejects.toThrow(`--${field}`)
      expect(call).not.toHaveBeenCalled()
    }
  )
})
