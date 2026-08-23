import { describe, expect, it } from 'vitest'
import { getWorktreeWatcherRemoval, setWorktreeWatcherRemoval } from './worktree-watcher-removal'

/**
 * Why: the port's default is inert by design — a host with no renderer has no watchers
 * to close. That is correct for orcad and silently wrong for the desktop, where an
 * uninstalled port means worktree removal stops releasing the directory and Windows
 * fails the delete on a locked file. The default is indistinguishable from a working
 * install at the call site, so it gets asserted here.
 */
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

  it('exposes a desktop binding that delegates rather than stubbing', async () => {
    // Why import lazily: filesystem-watcher pulls electron, so it must not load in the
    // inert-default case above.
    const { desktopWorktreeWatcherRemoval } = await import('./filesystem-watcher')
    for (const method of METHODS) {
      expect(typeof desktopWorktreeWatcherRemoval[method], method).toBe('function')
      // An inert stub is an empty arrow; a real delegation is not.
      expect(desktopWorktreeWatcherRemoval[method].toString(), method).not.toMatch(
        /^\s*(async )?\(\s*\)\s*=>\s*\{?\s*\}?\s*$/
      )
    }
  })
})
