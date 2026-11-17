import { describe, expect, it } from 'vitest'
import { readClaudeMessageEnvelope } from './claude-structured-item-translation'
import { ClaudeWorkingDirectory } from './claude-working-directory'

const ROOT = '/repo/.claude/worktrees/fix-login'

function frame(
  type: 'assistant' | 'user',
  content: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type,
    session_id: 'session',
    uuid: `${type}-${Math.random()}`,
    parent_tool_use_id: null,
    message: { role: type, content },
    ...extra
  }
}

function feed(tracker: ClaudeWorkingDirectory, message: Record<string, unknown>): void {
  const envelope = readClaudeMessageEnvelope(message)
  if (envelope) {
    tracker.observe(envelope, message)
  }
}

function call(id: string, name: string, input: unknown = {}): Record<string, unknown> {
  return frame('assistant', [{ type: 'tool_use', id, name, input }])
}

function result(id: string, text: string, isError = false): Record<string, unknown> {
  return frame('user', [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }])
}

describe('ClaudeWorkingDirectory', () => {
  it('follows EnterWorktree and returns to the launch directory on ExitWorktree', () => {
    const tracker = new ClaudeWorkingDirectory()
    feed(tracker, call('enter', 'EnterWorktree', { name: 'fix-login' }))
    expect(tracker.current).toBeUndefined()
    feed(tracker, result('enter', `Created worktree at ${ROOT} on branch fix-login.`))
    expect(tracker.current).toBe(ROOT)

    feed(tracker, call('exit', 'ExitWorktree', { action: 'keep' }))
    feed(tracker, result('exit', 'Returned to the original directory.'))
    expect(tracker.current).toBeUndefined()
  })

  it('ignores failed switches and switches made by subagents', () => {
    const tracker = new ClaudeWorkingDirectory()
    feed(tracker, call('bad', 'EnterWorktree', { path: '/elsewhere' }))
    feed(tracker, result('bad', 'Path is not a registered worktree', true))
    feed(
      tracker,
      frame('assistant', [{ type: 'tool_use', id: 'child', name: 'EnterWorktree', input: {} }], {
        parent_tool_use_id: 'task'
      })
    )
    feed(
      tracker,
      frame('user', [{ type: 'tool_result', tool_use_id: 'child', content: `at ${ROOT}` }], {
        parent_tool_use_id: 'task'
      })
    )
    expect(tracker.current).toBeUndefined()
  })

  it('reads worktree paths whose parent folders contain spaces', () => {
    const tracker = new ClaudeWorkingDirectory()
    const posix = '/Users/Jane Doe/repo/.claude/worktrees/fix-login'
    feed(tracker, call('posix', 'EnterWorktree', { name: 'fix-login' }))
    feed(tracker, result('posix', `Switched from /tmp/x to ${posix} on branch fix-login.`))
    expect(tracker.current).toBe(posix)

    const windows = 'C:\\Users\\Jane Doe\\repo\\.claude\\worktrees\\fix-login'
    feed(tracker, call('windows', 'EnterWorktree', { name: 'fix-login' }))
    feed(tracker, result('windows', `Created worktree at "${windows}".`))
    expect(tracker.current).toBe(windows)
  })

  it('uses an existing worktree path given as input when the result names none', () => {
    const tracker = new ClaudeWorkingDirectory()
    feed(tracker, call('enter', 'EnterWorktree', { path: 'C:\\repo\\wt-review' }))
    feed(tracker, result('enter', 'Switched into the worktree.'))
    expect(tracker.current).toBe('C:\\repo\\wt-review')
  })
})
