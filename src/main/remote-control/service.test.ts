import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import { buildRemoteControlSessions } from './service'

describe('buildRemoteControlSessions', () => {
  it('sorts sessions by recent output and exposes control capabilities for writable terminals', () => {
    const terminals: RuntimeTerminalSummary[] = [
      {
        handle: 'term-1',
        worktreeId: 'wt-a',
        worktreePath: '/repo/a',
        branch: 'feature/a',
        tabId: 'tab-a',
        leafId: 'leaf-a',
        title: 'Claude',
        connected: true,
        writable: true,
        lastOutputAt: 200,
        preview: 'latest output'
      },
      {
        handle: 'term-2',
        worktreeId: 'wt-b',
        worktreePath: '/repo/b',
        branch: 'feature/b',
        tabId: 'tab-b',
        leafId: 'leaf-b',
        title: 'Codex',
        connected: true,
        writable: false,
        lastOutputAt: 100,
        preview: 'older output'
      }
    ]

    const sessions = buildRemoteControlSessions(terminals)

    expect(sessions.map((session) => session.sessionId)).toEqual(['tab-a:leaf-a', 'tab-b:leaf-b'])
    expect(sessions[0].capabilities).toEqual([
      'view_output',
      'switch_session',
      'send_input',
      'send_interrupt',
      'approve_action',
      'run_command'
    ])
    expect(sessions[1].capabilities).toEqual(['view_output', 'switch_session'])
  })
})
