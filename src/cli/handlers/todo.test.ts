import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getOptionalWorktreeSelectorMock = vi.hoisted(() => vi.fn())
const resolveCurrentWorktreeSelectorMock = vi.hoisted(() => vi.fn())

// Why: isolate the handler's scope/flag-to-param mapping; printResult and the
// formatters only render output.
vi.mock('../format', () => ({
  printResult: vi.fn(),
  formatTodoList: vi.fn(),
  formatTodoMutation: vi.fn(),
  formatTodoDelete: vi.fn()
}))
vi.mock('../selectors', () => ({
  getOptionalWorktreeSelector: getOptionalWorktreeSelectorMock,
  resolveCurrentWorktreeSelector: resolveCurrentWorktreeSelectorMock
}))

import { TODO_HANDLERS } from './todo'

const invoke = (command: string, flags: Map<string, string | boolean>) =>
  TODO_HANDLERS[command]({
    flags,
    client: { call: callMock },
    cwd: '/work',
    json: true
  } as never)

beforeEach(() => {
  callMock.mockReset().mockResolvedValue({ result: {} })
  getOptionalWorktreeSelectorMock.mockReset().mockResolvedValue(undefined)
  resolveCurrentWorktreeSelectorMock.mockReset().mockResolvedValue('id:repo-1::wt-1')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('todo CLI scope resolution', () => {
  it('defaults to the current worktree', async () => {
    await invoke('todo list', new Map())
    expect(callMock).toHaveBeenCalledWith('todo.list', { worktree: 'id:repo-1::wt-1' })
  })

  it('uses an explicit --worktree selector', async () => {
    getOptionalWorktreeSelectorMock.mockResolvedValue('id:wt-9')
    await invoke('todo list', new Map([['worktree', 'id:wt-9']]))
    expect(callMock).toHaveBeenCalledWith('todo.list', { worktree: 'id:wt-9' })
  })

  it('derives the project from the current worktree for bare --project', async () => {
    await invoke('todo list', new Map([['project', true]]))
    expect(callMock).toHaveBeenCalledWith('todo.list', { repo: 'id:repo-1', scope: 'project' })
  })

  it('uses --project <repo-selector> directly', async () => {
    await invoke('todo list', new Map([['project', 'id:repo-2']]))
    expect(callMock).toHaveBeenCalledWith('todo.list', { repo: 'id:repo-2', scope: 'project' })
  })

  it('honors --scope project with an explicit --repo', async () => {
    await invoke(
      'todo list',
      new Map<string, string | boolean>([
        ['scope', 'project'],
        ['repo', 'id:repo-3']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('todo.list', { repo: 'id:repo-3', scope: 'project' })
  })
})

describe('todo CLI mutations', () => {
  it('sends the body without an authorRole (the runtime stamps agent)', async () => {
    await invoke('todo add', new Map([['body', 'Write tests']]))
    expect(callMock).toHaveBeenCalledWith('todo.add', {
      worktree: 'id:repo-1::wt-1',
      body: 'Write tests'
    })
  })

  it('marks complete by default and re-opens with --reopen', async () => {
    await invoke('todo complete', new Map([['id', 'todo-1']]))
    expect(callMock).toHaveBeenCalledWith('todo.complete', {
      worktree: 'id:repo-1::wt-1',
      id: 'todo-1',
      completed: true
    })

    callMock.mockClear()
    await invoke(
      'todo complete',
      new Map<string, string | boolean>([
        ['id', 'todo-1'],
        ['reopen', true]
      ])
    )
    expect(callMock).toHaveBeenCalledWith('todo.complete', {
      worktree: 'id:repo-1::wt-1',
      id: 'todo-1',
      completed: false
    })
  })

  it('deletes by id', async () => {
    await invoke('todo delete', new Map([['id', 'todo-1']]))
    expect(callMock).toHaveBeenCalledWith('todo.delete', {
      worktree: 'id:repo-1::wt-1',
      id: 'todo-1'
    })
  })
})
