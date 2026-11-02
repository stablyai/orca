import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClient } from '../runtime-client'
import {
  RemovedWorkEntrySchema,
  type RemovedWorkEntry
} from '../../shared/orchestration-removed-work'
import {
  formatRemovedWorkListing,
  formatResetResult,
  formatRunRemovedWorkLine
} from './orchestration/removed-work-format'
import { okFixture, queueFixtures } from '../test-fixtures'
import { ORCHESTRATION_RETAINED_RUN_BINDINGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('lightweight Run CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  })

  it('creates a Run with the resolved coordinator terminal', async () => {
    queueFixtures(
      callMock,
      okFixture('req_identity', { identity: { handle: 'term_coord', live: true } }),
      okFixture('req_status', {
        capabilities: [ORCHESTRATION_RETAINED_RUN_BINDINGS_RUNTIME_CAPABILITY]
      }),
      okFixture('req_run', {
        run: { id: 'run_1', objective: 'Coordinate work', consumer_generation: 1 }
      })
    )
    await ORCHESTRATION_HANDLERS['orchestration run-create']({
      flags: new Map<string, string | boolean>([
        ['objective', 'Coordinate work'],
        ['json', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith('orchestration.runCreate', {
      objective: 'Coordinate work',
      from: 'term_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_coord'
    })
    expect(callMock).toHaveBeenCalledTimes(3)
  })

  it('reuses the same explicit binding path for run-use and run-current', async () => {
    callMock
      .mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
      .mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
    await ORCHESTRATION_HANDLERS['orchestration run-use']({
      flags: new Map([
        ['id', 'run_1'],
        ['from', 'term_coord']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    await ORCHESTRATION_HANDLERS['orchestration run-current']({
      flags: new Map([['from', 'term_coord']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenNthCalledWith(1, 'orchestration.runUse', {
      id: 'run_1',
      from: 'term_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.runCurrent', {
      from: 'term_coord'
    })
  })

  it('passes Run pagination flags to the runtime', async () => {
    callMock.mockResolvedValue({
      result: { runs: [], nextCursor: null }
    })

    await ORCHESTRATION_HANDLERS['orchestration run-list']({
      flags: new Map([
        ['limit', '25'],
        ['cursor', 'next-page']
      ]),
      client: { call: callMock },
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runList', {
      limit: 25,
      cursor: 'next-page'
    })
  })

  it('opts into bounded Run pagination by default', async () => {
    callMock.mockResolvedValue({ result: { runs: [], nextCursor: null } })

    await ORCHESTRATION_HANDLERS['orchestration run-list']({
      flags: new Map(),
      client: { call: callMock },
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runList', {
      limit: 10,
      cursor: undefined
    })
  })

  it('passes explicit legacy takeover only when requested', async () => {
    callMock.mockResolvedValue({
      result: { run: { id: 'run_adopted', objective: 'Recovered work' } }
    })
    await ORCHESTRATION_HANDLERS['orchestration run-use']({
      flags: new Map<string, string | boolean>([
        ['id', 'run_adopted'],
        ['from', 'term_current'],
        ['takeover-legacy', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runUse', {
      id: 'run_adopted',
      from: 'term_current',
      takeoverLegacy: true
    })
  })
})

describe('orchestration reset CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { reset: 'all' } })
  })
  const invoke = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration reset']({
      flags,
      client: { call: callMock },
      json: true
    } as never)

  it('rejects a bare reset before calling the runtime', async () => {
    await expect(invoke(new Map())).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('sends only the tasks scope for --tasks', async () => {
    await invoke(new Map([['tasks', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: undefined,
      tasks: true,
      messages: undefined
    })
  })

  it('sends only the all scope for --all', async () => {
    await invoke(new Map([['all', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: true,
      tasks: undefined,
      messages: undefined
    })
  })

  it.each([
    new Map<string, string | boolean>([
      ['tasks', true],
      ['messages', true]
    ]),
    new Map<string, string | boolean>([
      ['all', true],
      ['tasks', true]
    ])
  ])('rejects multiple reset scopes before calling the runtime', async (flags) => {
    await expect(invoke(flags)).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('removed work CLI text', () => {
  const summary = {
    coverage: 'partial' as const,
    recordedSince: '2026-10-19T00:00:00Z',
    tasks: 2,
    dispatches: 1,
    workers: 1,
    terminals: 1,
    activeWorkersAtRemoval: 1,
    lastRemovedAt: '2026-10-19T01:00:00Z'
  }
  const list = 'orca orchestration run-show --id run_1 --removed'

  it('adds a run-show line only when the Run has removed work', async () => {
    expect(formatRunRemovedWorkLine('run_1', undefined)).toBe('')
    expect(
      formatRunRemovedWorkLine('run_1', {
        ...summary,
        tasks: 0,
        dispatches: 0,
        workers: 0,
        terminals: 0
      })
    ).toBe('')
    expect(formatRunRemovedWorkLine('run_1', summary)).toBe(
      `\nremoved work: 2 tasks, 1 dispatch, 1 worker (1 may still be running), 1 terminal; removals before 2026-10-19T00:00:00Z were not recorded. List it: ${list}`
    )
    const client = new RuntimeClient()
    const call = vi.spyOn(client, 'call').mockResolvedValue({
      id: 'request',
      ok: true,
      result: { run: { id: 'run_1' } },
      _meta: { runtimeId: 'runtime-1' }
    })
    await ORCHESTRATION_HANDLERS['orchestration run-show']({
      flags: new Map([
        ['id', 'run_1'],
        ['cursor', '200']
      ]),
      client,
      cwd: '/tmp',
      json: true
    })
    expect(call).toHaveBeenCalledWith('orchestration.runShow', {
      id: 'run_1',
      removed: true,
      cursor: '200'
    })
  })

  it('lists removed entries with a next page, and says when the host keeps no record', () => {
    expect(formatRemovedWorkListing('run_1', undefined)).toBe(
      'No record of removed work is available from this Orca host.'
    )
    expect(formatRemovedWorkListing('run_1', { ...summary, entries: [] }, '99')).toBe(
      'No more removed work in this Run after cursor 99.'
    )
    const entries: RemovedWorkEntry[] = [
      RemovedWorkEntrySchema.parse({
        seq: 1,
        kind: 'task',
        id: 'task_x',
        removedAt: '',
        title: 'Build',
        parentTaskId: 'task_y',
        createdByHandle: 'term_a'
      }),
      RemovedWorkEntrySchema.parse({
        seq: 2,
        kind: 'worker',
        id: 'ctx_x',
        removedAt: '',
        terminalHandle: 'term_b',
        worktreeId: 'w',
        state: 'ready',
        activeAtRemoval: true
      }),
      { seq: 3, kind: 'dispatch', id: 'ctx_y', removedAt: '', unreadable: true },
      RemovedWorkEntrySchema.parse({
        seq: 4,
        kind: 'terminal',
        id: 'wtr_x',
        removedAt: '',
        terminalHandle: 'term_b',
        ownershipState: 'user_owned'
      })
    ]
    expect(
      formatRemovedWorkListing('run_1', {
        ...summary,
        coverage: 'complete',
        entries,
        page: { hasMore: true, nextCursor: '3' }
      })
    ).toBe(
      [
        'Removed work in run_1',
        'task task_x "Build", parent task_y, created by term_a',
        'worker ctx_x in term_b (worktree w): ready when removed, may still be running',
        'dispatch ctx_y: record unreadable',
        'terminal wtr_x term_b: taken over by the user',
        `More: ${list} --cursor 3`
      ].join('\n')
    )
  })

  it('summarizes what a task reset removed', () => {
    expect(formatResetResult({ reset: 'tasks' })).toBe('Reset: tasks')
    expect(
      formatResetResult({
        reset: 'tasks',
        removed: {
          runs: 1,
          runIds: ['run_1'],
          tasks: 3,
          dispatches: 4,
          workers: 2,
          possiblyRunning: 1
        }
      })
    ).toBe(
      'Reset: tasks. Removed 3 tasks, 4 dispatches and 2 workers from 1 Run. 1 worker may still be running: reset stops tracking workers but does not stop them. List what was removed: orca orchestration run-show --id run_1 --removed'
    )
    expect(
      formatResetResult({
        reset: 'tasks',
        removed: {
          runs: 2,
          runIds: ['run_1', 'run_2'],
          tasks: 1,
          dispatches: 0,
          workers: 0,
          possiblyRunning: 0
        }
      })
    ).toBe(
      'Reset: tasks. Removed 1 task, 0 dispatches and 0 workers from 2 Runs. Runs: run_1, run_2. List what was removed in one: orca orchestration run-show --removed --id RUN_ID'
    )
  })
})
