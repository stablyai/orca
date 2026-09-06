import { describe, expect, it, vi } from 'vitest'
import { MobileWebNavigationIntentBuffer } from './mobile-web-navigation-intent-buffer'

describe('mobile web navigation intent buffer', () => {
  it('retains only the latest bounded native target across listener timing', () => {
    const buffer = new MobileWebNavigationIntentBuffer()
    const first = buffer.publish({ kind: 'host', hostId: 'host-one' })
    const listener = vi.fn()

    const unsubscribe = buffer.subscribe(listener)
    expect(listener).toHaveBeenLastCalledWith({
      sequence: first.sequence,
      source: 'notification',
      hostId: 'host-one',
      target: { kind: 'workspaceList' }
    })
    const second = buffer.publish({
      kind: 'session',
      hostId: 'host-two',
      hostWorkspaceId: 'repo::/private/worktree'
    })
    expect(second.sequence).toBeGreaterThan(first.sequence)
    expect(listener).toHaveBeenLastCalledWith({
      sequence: second.sequence,
      source: 'notification',
      hostId: 'host-two',
      target: { kind: 'session', hostWorkspaceId: 'repo::/private/worktree' }
    })
    expect(JSON.stringify(second)).not.toContain('http')

    expect(buffer.consume(first.sequence)).toBe(false)
    expect(buffer.isCurrent(second.sequence)).toBe(true)
    expect(buffer.consume(second.sequence)).toBe(true)
    expect(buffer.isCurrent(second.sequence)).toBe(false)

    unsubscribe()
  })

  it('supersedes an unconsumed intent before a delayed resolver can commit it', () => {
    const buffer = new MobileWebNavigationIntentBuffer()
    const first = buffer.publish({
      kind: 'session',
      hostId: 'host',
      hostWorkspaceId: 'workspace-one'
    })
    const second = buffer.publish({
      kind: 'session',
      hostId: 'host',
      hostWorkspaceId: 'workspace-two'
    })

    expect(buffer.isCurrent(first.sequence)).toBe(false)
    expect(buffer.isCurrent(second.sequence)).toBe(true)
  })

  it('labels cold restoration without changing the shared sequence domain', () => {
    const buffer = new MobileWebNavigationIntentBuffer()
    const restored = buffer.publish(
      { kind: 'session', hostId: 'host', hostWorkspaceId: 'workspace' },
      'coldResume'
    )
    const notification = buffer.publish({ kind: 'host', hostId: 'host' })

    expect(restored.source).toBe('coldResume')
    expect(notification.source).toBe('notification')
    expect(notification.sequence).toBeGreaterThan(restored.sequence)
  })

  it('accepts typed Home destinations without host credentials or paths', () => {
    const buffer = new MobileWebNavigationIntentBuffer()
    const intent = buffer.publishHostTarget('paired-host', { kind: 'tasks', taskSource: 'linear' })

    expect(intent).toEqual({
      sequence: 0,
      source: 'home',
      hostId: 'paired-host',
      target: { kind: 'tasks', taskSource: 'linear' }
    })
  })

  it('carries a host notice through a workspace-list intent', () => {
    const buffer = new MobileWebNavigationIntentBuffer()
    const intent = buffer.publishHostTarget('paired-host', {
      kind: 'workspaceList',
      notice: 'worktree-missing'
    })

    expect(intent.target).toEqual({ kind: 'workspaceList', notice: 'worktree-missing' })
  })
})
