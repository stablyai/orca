import { describe, expect, it } from 'vitest'
import {
  acquireWatcherRemovalGate,
  beginTerminalInstall,
  beginWatcherInstall,
  tryAcquireIdleWatcherRemovalGate,
  TerminalRemovalInProgressError
} from './watcher-removal-gate'

describe('idle-only watcher removal admission', () => {
  it('refuses an earlier terminal start without cancelling or abandoning it', async () => {
    const root = '/idle-refusal/terminal'
    const finish = beginTerminalInstall(root)
    expect(tryAcquireIdleWatcherRemovalGate(root)).toEqual({
      kind: 'refused',
      reason: 'install_in_progress'
    })
    const removal = acquireWatcherRemovalGate(root)
    let drained = false
    void removal.ready.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    finish()
    await removal.ready
    expect(drained).toBe(true)
    removal.release()
  })

  it.each([
    ['/idle-parent', '/idle-parent/child'],
    ['/idle-child/child', '/idle-child'],
    ['C:\\idle\\WORKTREE', 'c:/idle/worktree/child']
  ])('refuses overlapping installs: %s and %s', (root, installing) => {
    const finish = beginWatcherInstall(installing)
    expect(tryAcquireIdleWatcherRemovalGate(root)).toEqual({
      kind: 'refused',
      reason: 'install_in_progress'
    })
    finish()
    const result = tryAcquireIdleWatcherRemovalGate(root)
    expect(result.kind).toBe('acquired')
    if (result.kind === 'acquired') {
      result.gate.release()
    }
  })

  it('fences a new start through the entire accepted transaction and releases exactly once', async () => {
    const root = '/idle-race/checkout'
    const result = tryAcquireIdleWatcherRemovalGate(root)
    expect(result.kind).toBe('acquired')
    if (result.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    await Promise.resolve()
    expect(() => beginTerminalInstall(root)).toThrow(TerminalRemovalInProgressError)
    expect(() => beginTerminalInstall(`${root}/nested`)).toThrow(TerminalRemovalInProgressError)
    expect(tryAcquireIdleWatcherRemovalGate(root)).toEqual({
      kind: 'refused',
      reason: 'removal_in_progress'
    })
    result.gate.release()
    result.gate.release()
    const finish = beginTerminalInstall(root)
    finish()
  })

  it('does not block or adopt an install on a different host or sibling checkout', () => {
    const root = '/idle-scope/checkout'
    const finishOther = beginTerminalInstall(root, 'ssh-other')
    const finishSibling = beginTerminalInstall('/idle-scope/sibling', 'ssh-owner')
    const result = tryAcquireIdleWatcherRemovalGate(root, 'ssh-owner')
    expect(result.kind).toBe('acquired')
    if (result.kind === 'acquired') {
      result.gate.release()
    }
    finishOther()
    finishSibling()
  })
})
