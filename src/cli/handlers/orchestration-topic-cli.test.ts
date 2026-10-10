import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeClient } from '../runtime-client'

const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration topic CLI mapping', () => {
  beforeEach(() => {
    getTerminalHandleMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
  })

  afterEach(() => {
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  it('maps topic-set to one explicit task policy mutation', async () => {
    const client = new RuntimeClient(join(tmpdir(), 'orca-topic-cli-test'), 1000, null, null)
    const call = vi.spyOn(client, 'call')
    call
      .mockResolvedValueOnce({
        id: 'test',
        ok: true,
        result: { identity: { handle: 'term_creator', live: true } },
        _meta: { runtimeId: 'test' }
      })
      .mockResolvedValueOnce({
        id: 'test',
        ok: true,
        result: {
          policy: {
            taskId: 'task_1',
            runId: 'run_1',
            publishes: ['findings'],
            subscribes: ['review']
          }
        },
        _meta: { runtimeId: 'test' }
      })

    await ORCHESTRATION_HANDLERS['orchestration topic-set']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['publishes', '["findings"]'],
        ['subscribes', '["review"]']
      ]),
      client,
      cwd: tmpdir(),
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(2, 'orchestration.topicSet', {
      task: 'task_1',
      publishes: '["findings"]',
      subscribes: '["review"]',
      run: undefined,
      callerTerminalHandle: 'term_creator'
    })
  })
})
