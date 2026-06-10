import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { ClaudeChatManager } from './claude-chat-manager'
import type { ChatCheckpoints } from './chat-checkpoints'

type FakeChild = {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
  on(event: string, cb: (...args: unknown[]) => void): FakeChild
  emit(event: string, ...args: unknown[]): boolean
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  ;(child as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).stdin = { write: vi.fn(), end: vi.fn() }
  ;(child as unknown as Record<string, unknown>).kill = vi.fn()
  return child
}

function fakeCheckpoints(
  result: Awaited<ReturnType<ChatCheckpoints['snapshot']>>
): ChatCheckpoints {
  return {
    snapshot: vi.fn().mockResolvedValue(result),
    revert: vi.fn().mockResolvedValue(true),
    changedFiles: vi.fn().mockResolvedValue([])
  } as unknown as ChatCheckpoints
}

describe('ClaudeChatManager', () => {
  it('forwards onEvent to send with the correct worktreeId', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const send = vi.fn()
    const manager = new ClaudeChatManager({ send, spawn })

    await manager.send('wt', '/cwd', 'hi')

    // Emit a system event from the fake child stdout
    const systemEvent = { type: 'system', subtype: 'init', session_id: 'abc' }
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(systemEvent)}\n`))

    expect(send).toHaveBeenCalledWith('claudeChat:event', {
      worktreeId: 'wt',
      event: expect.objectContaining({ type: 'system', session_id: 'abc' })
    })
  })

  it('reuses the same session instance on subsequent sends', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const send = vi.fn()
    const manager = new ClaudeChatManager({ send, spawn })

    await manager.send('wt', '/cwd', 'first')
    await manager.send('wt', '/cwd', 'second')

    // Only one session should exist for the same worktreeId
    expect(manager.sessionCount()).toBe(1)
  })

  it('appends attachment @mentions to the prompt text', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const manager = new ClaudeChatManager({ send: vi.fn(), spawn })

    await manager.send('wt', '/cwd', 'review this', {
      attachments: ['/some/file.ts', '/other/doc.md']
    })

    const written: string = child.stdin.write.mock.calls[0][0]
    expect(written).toContain('@/some/file.ts')
    expect(written).toContain('@/other/doc.md')
  })

  it('stop() removes the session', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const manager = new ClaudeChatManager({ send: vi.fn(), spawn })

    await manager.send('wt', '/cwd', 'hi')
    expect(manager.sessionCount()).toBe(1)

    manager.stop('wt')
    expect(manager.sessionCount()).toBe(0)
    expect(child.kill).toHaveBeenCalled()
  })

  it('resume() sets sessionId so the next send spawns with --resume', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const manager = new ClaudeChatManager({ send: vi.fn(), spawn })

    manager.resume('wt', '/cwd', 'sX')
    await manager.send('wt', '/cwd', 'continue')

    const spawnArgs: string[] = spawn.mock.calls[0][1] as string[]
    expect(spawnArgs).toContain('--resume')
    expect(spawnArgs).toContain('sX')
  })

  it('reset() drops the session so next send starts fresh (no --resume)', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const manager = new ClaudeChatManager({ send: vi.fn(), spawn })

    // First: send to create a session (gets a sessionId from system event)
    await manager.send('wt', '/cwd', 'hi')
    const systemEvent = { type: 'system', subtype: 'init', session_id: 'old-id' }
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(systemEvent)}\n`))

    // Reset clears the session
    manager.reset('wt')
    expect(manager.sessionCount()).toBe(0)

    // Next send should spawn without --resume
    const child2 = fakeChild()
    spawn.mockReturnValue(child2)
    await manager.send('wt', '/cwd', 'new message')

    const spawnArgs: string[] = spawn.mock.calls[1][1] as string[]
    expect(spawnArgs).not.toContain('--resume')
  })

  it('emits a synthetic checkpoint event before claude receives input when checkpoints is set', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    // Why: record cross-mock invocation order — call indexes within a single
    // mock cannot prove the checkpoint preceded the stdin write.
    const callOrder: string[] = []
    const send = vi.fn((_channel: string, payload: unknown) => {
      if ((payload as { event?: { type?: string } }).event?.type === 'checkpoint') {
        callOrder.push('checkpoint')
      }
    })
    child.stdin.write.mockImplementation(() => {
      callOrder.push('stdin')
    })
    const checkpoints = fakeCheckpoints({
      sha: 'cafebabe',
      createdAt: '2024-01-01T00:00:00.000Z',
      label: 'my label'
    })
    const manager = new ClaudeChatManager({ send, spawn, checkpoints })

    await manager.send('wt', '/cwd', 'my message')

    // checkpoint event emitted
    expect(send).toHaveBeenCalledWith('claudeChat:event', {
      worktreeId: 'wt',
      event: {
        type: 'checkpoint',
        sha: 'cafebabe',
        createdAt: '2024-01-01T00:00:00.000Z',
        label: 'my label'
      }
    })

    // checkpoint event must have been emitted BEFORE claude gets the stdin write
    expect(callOrder).toEqual(['checkpoint', 'stdin'])
  })

  it('does not emit a checkpoint event when checkpoints is absent', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const send = vi.fn()
    const manager = new ClaudeChatManager({ send, spawn })

    await manager.send('wt', '/cwd', 'hi')

    const checkpointCalls = send.mock.calls.filter(
      (c) =>
        c[0] === 'claudeChat:event' &&
        (c[1] as { event: { type: string } }).event.type === 'checkpoint'
    )
    expect(checkpointCalls).toHaveLength(0)
  })

  it('does not emit a checkpoint event when snapshot returns null', async () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const send = vi.fn()
    const checkpoints = fakeCheckpoints(null)
    const manager = new ClaudeChatManager({ send, spawn, checkpoints })

    await manager.send('wt', '/cwd', 'hi')

    const checkpointCalls = send.mock.calls.filter(
      (c) =>
        c[0] === 'claudeChat:event' &&
        (c[1] as { event: { type: string } }).event.type === 'checkpoint'
    )
    expect(checkpointCalls).toHaveLength(0)
    // session still receives the message
    expect(child.stdin.write).toHaveBeenCalled()
  })
})
