import { beforeEach, describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { resetRemoteSessionParseCacheForTests } from './remote-session-scanner-parse-cache'
import {
  codexTranscript,
  jsonLines,
  MemoryRemoteProvider
} from './remote-session-scanner-test-provider'

describe('scanRemoteAiVaultSessions', () => {
  beforeEach(() => {
    resetRemoteSessionParseCacheForTests()
  })

  it('parses remote default and Orca-managed Codex homes with SSH host ids', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/session_index.jsonl',
      jsonLines([{ id: 'default-session', thread_name: 'Indexed remote title' }]),
      1
    )
    provider.addFile(
      '/home/ada/.codex/sessions/2026/07/04/default.jsonl',
      jsonLines([
        {
          timestamp: '2026-07-04T01:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'default-session', cwd: '/home/ada/repo' }
        },
        {
          timestamp: '2026-07-04T01:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Fallback default title' }]
          }
        }
      ]),
      10
    )
    provider.addFile(
      '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/runtime.jsonl',
      jsonLines([
        {
          timestamp: '2026-07-04T02:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'runtime-session', cwd: '/home/ada/runtime-repo' }
        },
        {
          timestamp: '2026-07-04T02:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Managed remote title' }]
          }
        }
      ]),
      20
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title)).toEqual([
      'Managed remote title',
      'Indexed remote title'
    ])
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(2)
    expect(result.sessions.every((session) => session.executionHostId === 'ssh:dev-box')).toBe(true)
    expect(result.sessions.every((session) => session.executionHostPlatform === 'linux')).toBe(true)
    expect(
      result.sessions.find((session) => session.sessionId === 'default-session')
    ).toMatchObject({
      codexHome: '/home/ada/.codex',
      resumeCommand:
        "cd '/home/ada/repo' && CODEX_HOME='/home/ada/.codex' codex resume 'default-session'"
    })
    expect(
      result.sessions.find((session) => session.sessionId === 'runtime-session')
    ).toMatchObject({
      codexHome: '/home/ada/.local/share/orca/codex-runtime-home/home',
      resumeCommand:
        "cd '/home/ada/runtime-repo' && CODEX_HOME='/home/ada/.local/share/orca/codex-runtime-home/home' codex resume 'runtime-session'"
    })
  })

  it('parses non-Codex transcripts through the same remote scanner', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.claude/projects/repo/claude-session.jsonl',
      jsonLines([
        {
          sessionId: 'claude-session',
          timestamp: '2026-07-04T04:00:00.000Z',
          type: 'user',
          message: { content: [{ type: 'text', text: 'Summarize the remote branch' }] }
        },
        {
          sessionId: 'claude-session',
          timestamp: '2026-07-04T04:00:01.000Z',
          type: 'assistant',
          message: { model: 'claude-opus-4', content: 'Sure.' }
        }
      ]),
      40
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      executionHostPlatform: 'linux',
      agent: 'claude',
      sessionId: 'claude-session',
      title: 'Summarize the remote branch',
      model: 'claude-opus-4',
      filePath: '/home/ada/.claude/projects/repo/claude-session.jsonl'
    })
  })

  it('builds resume commands with the remote host platform', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      'C:/Users/Ada/.codex/sessions/win.jsonl',
      jsonLines([
        {
          timestamp: '2026-07-04T03:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'win-session', cwd: 'C:/repo/app' }
        },
        {
          timestamp: '2026-07-04T03:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Windows remote title' }]
          }
        }
      ]),
      30
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:win-box',
      remoteHome: 'C:/Users/Ada',
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.executionHostPlatform).toBe('win32')
    expect(result.sessions[0]?.resumeCommand).toBe(
      'cmd /d /s /c "cd /d ""C:/repo/app"" && set ""CODEX_HOME=C:/Users/Ada/.codex"" && codex resume ""win-session"""'
    )
  })

  it('continues past skipped candidates to fill the remote scan limit', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/sessions/worker.jsonl',
      codexTranscript({
        sessionId: 'worker-session',
        title: 'Internal worker',
        cwd: '/home/ada/repo',
        timestamp: '2026-07-04T04:00:00.000Z',
        threadSource: 'agent'
      }),
      40
    )
    provider.addFile(
      '/home/ada/.codex/sessions/user.jsonl',
      codexTranscript({
        sessionId: 'user-session',
        title: 'Visible user session',
        cwd: '/home/ada/repo',
        timestamp: '2026-07-04T03:00:00.000Z'
      }),
      30
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      limit: 1
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['user-session'])
  })

  it('keeps scoped remote sessions even when they are older than the recency cap', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.codex/sessions/other.jsonl',
      codexTranscript({
        sessionId: 'other-session',
        title: 'Other workspace',
        cwd: '/home/ada/other',
        timestamp: '2026-07-04T05:00:00.000Z'
      }),
      50
    )
    provider.addFile(
      '/home/ada/.codex/sessions/scoped.jsonl',
      codexTranscript({
        sessionId: 'scoped-session',
        title: 'Scoped workspace',
        cwd: '/home/ada/repo/app',
        timestamp: '2026-07-04T01:00:00.000Z'
      }),
      10
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      limit: 1,
      scopePaths: ['/home/ada/repo']
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      'other-session',
      'scoped-session'
    ])
  })
})
