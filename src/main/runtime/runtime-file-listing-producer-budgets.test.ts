import { describe, expect, it, vi } from 'vitest'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
const { localList } = vi.hoisted(() => ({ localList: vi.fn() }))
vi.mock('../ipc/filesystem-list-files', () => ({ listQuickOpenFiles: localList }))

describe('runtime producer listing budgets', () => {
  useRuntimeFileCommandsLifecycle()
  it('passes the same sentinel budget before local enumeration', async () => {
    localList.mockImplementation(async (_root, _store, _excluded, _signal, maxResults) =>
      Array.from({ length: Math.min(5002, maxResults) }, (_, i) => `file-${i}.txt`)
    )
    const { commands } = createRuntimeFileCommands()
    const result = await commands.listMobileFiles('id:wt-1')
    expect(localList.mock.calls[0][4]).toBe(5001)
    expect(result.totalCount).toBe(5001)
    expect(result.truncated).toBe(true)
  })

  it('preserves the full local inventory and explicit caller limits', async () => {
    localList.mockClear()
    localList.mockImplementation(async (_root, _store, _excluded, _signal, maxResults) =>
      Array.from({ length: 25002 }, (_, i) => `file-${i}.txt`).slice(0, maxResults)
    )
    const { commands } = createRuntimeFileCommands()
    expect((await commands.listRuntimeFiles('id:wt-1')).at(-1)).toBe('file-25001.txt')
    expect(localList.mock.calls[0][4]).toBeUndefined()
    expect(await commands.listRuntimeFiles('id:wt-1', { maxResults: 3 })).toHaveLength(3)
  })

  it('refuses SSH Markdown listings without listing this machine', async () => {
    localList.mockClear()
    const { commands } = createRuntimeFileCommands({ hostId: 'ssh:host' })
    await expect(commands.listRuntimeMarkdownDocuments('id:wt-1')).rejects.toThrow(
      SshHostNotServedError
    )
    expect(localList).not.toHaveBeenCalled()
  })
})
