import { describe, expect, it } from 'vitest'
import { getWorktreeWatcherRemoval, setWorktreeWatcherRemoval } from './worktree-watcher-removal'

/** The renderer-less default stays inert; installed ports route method calls. */
describe('WorktreeWatcherRemoval port', () => {
  const METHODS = [
    'closeLocal',
    'restoreLocal',
    'forgetLocal',
    'closeRemote',
    'restoreRemote',
    'forgetRemote'
  ] as const

  it('defaults to inert so a renderer-less host is honest, not broken', async () => {
    setWorktreeWatcherRemoval(null)
    const inert = getWorktreeWatcherRemoval()
    for (const method of METHODS) {
      await expect(
        Promise.resolve(inert[method]('repo::/tmp/w', '/tmp/w' as never))
      ).resolves.not.toThrow()
    }
  })

  it('routes every method to the installed binding', async () => {
    const calls: string[] = []
    setWorktreeWatcherRemoval({
      closeLocal: async () => void calls.push('closeLocal'),
      restoreLocal: async () => void calls.push('restoreLocal'),
      forgetLocal: () => void calls.push('forgetLocal'),
      closeRemote: async () => void calls.push('closeRemote'),
      restoreRemote: async () => void calls.push('restoreRemote'),
      forgetRemote: () => void calls.push('forgetRemote')
    })
    for (const method of METHODS) {
      await getWorktreeWatcherRemoval()[method]('conn', '/tmp/w' as never)
    }
    expect(calls).toEqual([...METHODS])
    setWorktreeWatcherRemoval(null)
  })
})
