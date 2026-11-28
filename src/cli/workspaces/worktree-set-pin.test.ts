import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_HANDLERS } from './worktree'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClient } from '../runtime/client'
import { FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/worktree-runtime-capabilities'

const ok = (result: unknown) => ({
  id: 'request-1',
  ok: true as const,
  result,
  _meta: { runtimeId: 'runtime-1' }
})
const callMock = vi.fn(async (method: string, _params?: unknown) => {
  if (method === 'status.get') {
    return ok({ capabilities: [FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY] })
  }
  if (method === 'folderWorkspace.update') {
    return ok({ folderWorkspace: { id: 'f1' } })
  }
  return ok({ worktree: { id: 'repo::/tmp/wt', isPinned: true } })
})
const client = new RuntimeClient('/tmp/orca-worktree-set-pin-test', 60_000, null, null)
vi.spyOn(client, 'call').mockImplementation(callMock)

function context(worktree: string, extra: [string, string | boolean][]): HandlerContext {
  return { client, cwd: '/tmp', json: true, flags: new Map([['worktree', worktree], ...extra]) }
}

function calls(method: string): unknown[] {
  return callMock.mock.calls.filter(([name]) => name === method).map(([, params]) => params)
}

beforeEach(() => {
  callMock.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('worktree set --pin/--unpin', () => {
  it('sends isPinned true for --pin and false for --unpin', async () => {
    await WORKTREE_HANDLERS['worktree set'](context('id:repo::/tmp/wt', [['pin', true]]))
    await WORKTREE_HANDLERS['worktree set'](context('id:repo::/tmp/wt', [['unpin', true]]))
    expect(calls('worktree.set')).toEqual([
      expect.objectContaining({ isPinned: true }),
      expect.objectContaining({ isPinned: false })
    ])
  })

  it('refuses --pin with --unpin before any request', async () => {
    await expect(
      WORKTREE_HANDLERS['worktree set'](
        context('id:repo::/tmp/wt', [
          ['pin', true],
          ['unpin', true]
        ])
      )
    ).rejects.toThrow('Choose either --pin or --unpin, not both.')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('pins and unpins a folder workspace through folderWorkspace.update', async () => {
    await WORKTREE_HANDLERS['worktree set'](context('folder:f1', [['pin', true]]))
    await WORKTREE_HANDLERS['worktree set'](context('folder:f1', [['unpin', true]]))
    expect(calls('folderWorkspace.update')).toEqual([
      expect.objectContaining({ folderWorkspaceId: 'f1', updates: { isPinned: true } }),
      expect.objectContaining({ folderWorkspaceId: 'f1', updates: { isPinned: false } })
    ])
    expect(calls('worktree.set')).toEqual([])
  })
})
