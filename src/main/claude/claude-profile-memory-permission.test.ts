import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { respondAfterAgentToolPluginHooks } from '../agent-hooks/tool-events/agent-tool-plugin-hooks'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'
import {
  CLAUDE_MEMORY_PERMISSION_DECISION,
  claudeProfileMemoryPermissionAllow,
  type ClaudeMemoryPermissionRoots
} from './claude-profile-memory-permission'

const HOME = '/Users/ada'
const PROFILE = join(HOME, 'Library/Application Support/orca/claude-profiles/work/home')
const ROOTS: ClaudeMemoryPermissionRoots = { homeDir: HOME, profileHomes: [PROFILE] }
const HEADER = { 'x-orca-hook-decision': CLAUDE_MEMORY_PERMISSION_DECISION }
const ALLOW = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' }
  }
}

function post(hook: Record<string, unknown>) {
  return { paneKey: 'tab-1:0', payload: JSON.stringify(hook) }
}

function allow(filePath: string, tool = 'Write', event = 'PermissionRequest') {
  return claudeProfileMemoryPermissionAllow(
    'claude',
    post({ hook_event_name: event, tool_name: tool, tool_input: { file_path: filePath } }),
    HEADER,
    ROOTS
  )
}

afterEach(() => {
  setPluginHookRunner(null)
})

describe('claudeProfileMemoryPermissionAllow', () => {
  it('allows a profile memory file and the shared ~/.claude path it resolves to', () => {
    const profile = join(PROFILE, 'projects/-repo/memory/note.md')
    const shared = join(HOME, '.claude/projects/-repo/memory/note.md')
    expect(JSON.parse(allow(profile) ?? 'null')).toEqual(ALLOW)
    expect(JSON.parse(allow(shared, 'Edit') ?? 'null')).toEqual(ALLOW)
    expect(JSON.parse(allow(shared, 'MultiEdit') ?? 'null')).toEqual(ALLOW)
  })

  it('allows a path that normalizes back inside the memory directory', () => {
    const nested = join(HOME, '.claude/projects/-repo/memory/sub/../note.md')
    expect(JSON.parse(allow(nested) ?? 'null')).toEqual(ALLOW)
  })

  it('does not allow other tools, events, homes, or paths that leave memory', () => {
    const shared = join(HOME, '.claude/projects/-repo/memory/note.md')
    expect(allow(shared, 'Bash')).toBeNull()
    expect(allow(shared, 'Write', 'PreToolUse')).toBeNull()
    expect(allow(join(HOME, '.claude/projects/-repo/session.jsonl'))).toBeNull()
    expect(allow(join(HOME, '.claude/projects/-repo/memory'))).toBeNull()
    expect(allow('/tmp/orca/claude-profiles/work/home/projects/-repo/memory/note.md')).toBeNull()
    expect(allow(join(HOME, '.claude/projects/-repo/memory/../../secrets.md'))).toBeNull()
    expect(allow('/Users/other/.claude/projects/-repo/memory/note.md')).toBeNull()
    expect(allow(join(PROFILE, 'projects/-repo/memory/../../secrets.md'))).toBeNull()
    expect(
      claudeProfileMemoryPermissionAllow(
        'claude',
        post({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Write',
          tool_input: { file_path: shared }
        }),
        { 'x-orca-hook-decision': 'claude-pre-tool-use-v1' },
        ROOTS
      )
    ).toBeNull()
    expect(
      claudeProfileMemoryPermissionAllow(
        'codex',
        post({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Write',
          tool_input: { file_path: shared }
        }),
        HEADER,
        ROOTS
      )
    ).toBeNull()
  })

  it('answers allow when no plugin is listening', () => {
    const run = vi.fn()
    setPluginHookRunner({ wants: () => false, run })
    const res = { writeHead: vi.fn(), end: vi.fn(), socket: { setTimeout: vi.fn() } }
    const file = join(homedir(), '.claude/projects/-repo/memory/note.md')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the responder calls only writeHead, end and socket.setTimeout.
    void respondAfterAgentToolPluginHooks(
      res as unknown as ServerResponse,
      'claude',
      post({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Write',
        tool_input: { file_path: file }
      }),
      HEADER,
      null
    )
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' })
    expect(JSON.parse(String(res.end.mock.calls[0]?.[0]))).toEqual(ALLOW)
    expect(run).not.toHaveBeenCalled()
  })
})
