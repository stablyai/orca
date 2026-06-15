import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { ClaudeChatSession } from './claude-session'

// Why: intersect mocks with the plain call signatures so FakeChild stays
// structurally assignable to ClaudeChild under strict typecheck.
type FakeChild = {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: {
    write: ((s: string) => void) & ReturnType<typeof vi.fn>
    end: (() => void) & ReturnType<typeof vi.fn>
  }
  kill: (() => void) & ReturnType<typeof vi.fn>
  on(event: string, cb: (...args: never[]) => void): FakeChild
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

describe('ClaudeChatSession', () => {
  it('spawns with correct args and cwd on first send', () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const session = new ClaudeChatSession({ cwd: '/wt', spawn, onEvent: vi.fn() })
    session.send('hello')
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages'
    ])
    expect(opts).toMatchObject({ cwd: '/wt' })
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"text":"hello"'))
  })

  it('emits parsed events from stdout chunks', () => {
    const child = fakeChild()
    const onEvent = vi.fn()
    const session = new ClaudeChatSession({ cwd: '/wt', spawn: () => child, onEvent })
    session.send('hi')
    child.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"s9"}\n'))
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}\n'
      )
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', session_id: 's9' })
    )
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistant' }))
  })

  it('resumes with the captured session id on the second send', () => {
    const child1 = fakeChild()
    const child2 = fakeChild()
    const spawn = vi.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2)
    const session = new ClaudeChatSession({ cwd: '/wt', spawn, onEvent: vi.fn() })
    session.send('first')
    child1.stdout.emit(
      'data',
      Buffer.from('{"type":"system","subtype":"init","session_id":"sX"}\n')
    )
    child1.emit('close', 0)
    session.send('second')
    const args2 = spawn.mock.calls[1][1]
    expect(args2).toContain('--resume')
    expect(args2).toContain('sX')
  })

  it('includes --model and --effort when send opts are provided', () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const session = new ClaudeChatSession({ cwd: '/wt', spawn, onEvent: vi.fn() })
    session.send('hi', { model: 'opus', effort: 'high' })
    const [, args] = spawn.mock.calls[0]
    expect(args).toContain('--model')
    expect(args).toContain('opus')
    expect(args).toContain('--effort')
    expect(args).toContain('high')
  })

  it('does not include --model or --effort when no opts given', () => {
    const child = fakeChild()
    const spawn = vi.fn().mockReturnValue(child)
    const session = new ClaudeChatSession({ cwd: '/wt', spawn, onEvent: vi.fn() })
    session.send('hello')
    const [, args] = spawn.mock.calls[0]
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
  })

  it('retries once without --resume when the resumed session is not found', () => {
    const child1 = fakeChild()
    const child2 = fakeChild()
    const child3 = fakeChild()
    const spawn = vi
      .fn()
      .mockReturnValueOnce(child1)
      .mockReturnValueOnce(child2)
      .mockReturnValueOnce(child3)
    const onEvent = vi.fn()
    const session = new ClaudeChatSession({ cwd: '/wt', spawn, onEvent })
    session.setSessionId('dead-id')
    session.send('hello')
    expect(spawn.mock.calls[0][1]).toContain('--resume')
    // CLI reports the dead session
    child1.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: dead-id"]}\n'
      )
    )
    // → transparent retry without --resume, error never forwarded
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1][1]).not.toContain('--resume')
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'result' }))
    expect(child2.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"text":"hello"'))
  })

  it('synthesizes an error result when claude dies without emitting one', () => {
    const child = fakeChild()
    const onEvent = vi.fn()
    const session = new ClaudeChatSession({ cwd: '/wt', spawn: () => child, onEvent })
    session.send('x')
    child.stderr.emit('data', Buffer.from('command not found: something\n'))
    child.emit('close', 1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        is_error: true,
        errors: ['command not found: something']
      })
    )
  })

  it('stop() kills the child', () => {
    const child = fakeChild()
    const session = new ClaudeChatSession({ cwd: '/wt', spawn: () => child, onEvent: vi.fn() })
    session.send('x')
    session.stop()
    expect(child.kill).toHaveBeenCalled()
  })
})
