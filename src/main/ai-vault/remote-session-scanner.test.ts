import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../../shared/types'
import type { FileReadResult, FileStat, IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'

class MemoryRemoteProvider implements IFilesystemProvider {
  private readonly files = new Map<string, { content: string; mtimeMs: number }>()
  private readonly readDirErrors = new Map<string, Error>()
  private readonly statErrors = new Map<string, Error>()
  readonly readDirPaths: string[] = []

  addFile(path: string, content: string, mtimeMs: number): void {
    this.files.set(normalize(path), { content, mtimeMs })
  }

  failStat(path: string, error: Error): void {
    this.statErrors.set(normalize(path), error)
  }

  failReadDir(path: string, error: Error): void {
    this.readDirErrors.set(normalize(path), error)
  }

  async readDir(dirPath: string): Promise<DirEntry[]> {
    const dir = normalize(dirPath)
    this.readDirPaths.push(dir)
    const readDirError = this.readDirErrors.get(dir)
    if (readDirError) {
      throw readDirError
    }
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const entries = new Map<string, DirEntry>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue
      }
      const relative = path.slice(prefix.length)
      if (!relative) {
        continue
      }
      const [name, ...rest] = relative.split('/')
      if (!name) {
        continue
      }
      entries.set(name, {
        name,
        isDirectory: rest.length > 0,
        isSymlink: false
      })
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  async readFile(filePath: string): Promise<FileReadResult> {
    const file = this.files.get(normalize(filePath))
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`)
    }
    return { content: file.content, isBinary: false }
  }

  async stat(filePath: string): Promise<FileStat> {
    const statError = this.statErrors.get(normalize(filePath))
    if (statError) {
      throw statError
    }
    const file = this.files.get(normalize(filePath))
    if (!file) {
      throw new Error(`ENOENT: ${filePath}`)
    }
    return { size: file.content.length, type: 'file', mtime: file.mtimeMs, mtimeMs: file.mtimeMs }
  }

  writeFile = unsupported
  writeFileBase64 = unsupported
  writeFileBase64Chunk = unsupported
  deletePath = unsupported
  createFile = unsupported
  createDir = unsupported
  createDirNoClobber = unsupported
  rename = unsupported
  renameNoClobber = unsupported
  copy = unsupported
  realpath = async (path: string): Promise<string> => path
  search = unsupported
  listFiles = unsupported
  watch = unsupported
}

async function unsupported(): Promise<never> {
  throw new Error('unsupported')
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('scanRemoteAiVaultSessions', () => {
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

  it('collapses a bridged rollout present in both remote Codex homes to one row', async () => {
    const provider = new MemoryRemoteProvider()
    const rolloutName = 'rollout-2026-07-04T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
    const transcript = codexTranscript({
      sessionId: '019f0000-1111-7222-8333-444444444444',
      title: 'Bridged both-homes session',
      cwd: '/home/ada/repo',
      timestamp: '2026-07-04T10:00:00.000Z'
    })
    // Same rollout name in both homes — the in-distro bridge/backfill hardlink.
    provider.addFile(`/home/ada/.codex/sessions/2026/07/04/${rolloutName}`, transcript, 3_000)
    provider.addFile(
      `/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/04/${rolloutName}`,
      transcript,
      3_000
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:build-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    // Remote lanes have not flipped to the real home: the managed runtime-home
    // row stays canonical so resume keeps Orca-refreshed auth, as today.
    expect(result.sessions[0]).toMatchObject({
      sessionId: '019f0000-1111-7222-8333-444444444444',
      codexHome: '/home/ada/.local/share/orca/codex-runtime-home/home'
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

  it('parses only canonical Antigravity transcripts on SSH hosts', async () => {
    const provider = new MemoryRemoteProvider()
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const logsDir = `/home/ada/.gemini/antigravity-cli/brain/${sessionId}/.system_generated/logs`
    provider.addFile(
      `${logsDir}/transcript.jsonl`,
      jsonLines([
        {
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-07-15T11:39:10Z',
          content: '<USER_REQUEST>Fix remote Antigravity history</USER_REQUEST>'
        },
        {
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-07-15T11:39:12Z',
          content: 'Done'
        }
      ]),
      50
    )
    provider.addFile(`${logsDir}/transcript_full.jsonl`, 'duplicate', 51)
    provider.addFile(
      `/home/ada/.gemini/antigravity-cli/brain/${sessionId}/artifacts/task.jsonl`,
      'not a transcript',
      52
    )
    provider.addFile(
      '/home/ada/.gemini/antigravity-cli/history.jsonl',
      jsonLines([
        {
          display: 'Fix remote Antigravity history',
          timestamp: Date.parse('2026-07-15T11:39:10.100Z'),
          workspace: '/home/ada/project'
        }
      ]),
      53
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scopePaths: ['/home/ada/project']
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      executionHostPlatform: 'linux',
      agent: 'antigravity',
      sessionId,
      title: 'Fix remote Antigravity history',
      cwd: '/home/ada/project',
      messageCount: 2,
      resumeCommand: `agy --conversation '${sessionId}'`,
      filePath: `${logsDir}/transcript.jsonl`
    })
    expect(
      provider.readDirPaths.filter((path) =>
        path.startsWith('/home/ada/.gemini/antigravity-cli/brain')
      )
    ).toEqual(['/home/ada/.gemini/antigravity-cli/brain'])
  })

  it('keeps Antigravity SSH discovery to one listing as the session store grows', async () => {
    const provider = new MemoryRemoteProvider()
    const brainDir = '/home/ada/.gemini/antigravity-cli/brain'
    for (let index = 0; index < 40; index++) {
      provider.addFile(
        `${brainDir}/session-${index}/.system_generated/logs/transcript.jsonl`,
        jsonLines([
          {
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            created_at: `2026-07-15T11:39:${String(index).padStart(2, '0')}Z`,
            content: `<USER_REQUEST>Remote session ${index}</USER_REQUEST>`
          }
        ]),
        100 + index
      )
    }

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(40)
    expect(provider.readDirPaths.filter((path) => path.startsWith(brainDir))).toEqual([brainDir])
  })

  it('ignores missing canonical Antigravity transcripts but reports other stat failures', async () => {
    const provider = new MemoryRemoteProvider()
    const brainDir = '/home/ada/.gemini/antigravity-cli/brain'
    provider.addFile(`${brainDir}/missing-session/artifacts/task.jsonl`, 'artifact', 1)
    const deniedTranscript = `${brainDir}/denied-session/.system_generated/logs/transcript.jsonl`
    provider.addFile(deniedTranscript, 'unreadable', 2)
    provider.failStat(
      deniedTranscript,
      new Error(`EACCES: permission denied, stat '${deniedTranscript}'`)
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        agent: 'antigravity',
        path: deniedTranscript,
        message: expect.stringContaining('EACCES')
      })
    ])
  })

  it('reports non-missing fixed and recursive remote directory failures', async () => {
    const provider = new MemoryRemoteProvider()
    const brainDir = '/home/ada/.gemini/antigravity-cli/brain'
    const claudeProjectDir = '/home/ada/.claude/projects/repo'
    provider.addFile(`${claudeProjectDir}/session.jsonl`, 'unreadable', 1)
    provider.failReadDir(brainDir, new Error(`EACCES: permission denied, scandir '${brainDir}'`))
    provider.failReadDir(
      claudeProjectDir,
      new Error(`ECONNRESET: connection lost while reading '${claudeProjectDir}'`)
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'antigravity',
          path: brainDir,
          message: expect.stringContaining('EACCES')
        }),
        expect.objectContaining({
          agent: 'claude',
          path: claudeProjectDir,
          message: expect.stringContaining('ECONNRESET')
        })
      ])
    )
    expect(result.issues).toHaveLength(2)
  })

  it('keeps missing optional remote directories silent', async () => {
    const provider = new MemoryRemoteProvider()
    const brainDir = '/home/ada/.gemini/antigravity-cli/brain'
    provider.failReadDir(brainDir, new Error(`ENOENT: no such directory, scandir '${brainDir}'`))

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('excludes Claude subagent transcripts from remote scans', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.claude/projects/repo/claude-session.jsonl',
      jsonLines([
        {
          sessionId: 'claude-session',
          timestamp: '2026-07-04T04:00:00.000Z',
          type: 'user',
          message: { content: [{ type: 'text', text: 'Spawn a Task' }] }
        }
      ]),
      40
    )
    provider.addFile(
      '/home/ada/.claude/projects/repo/claude-session/subagents/agent-abc123.jsonl',
      jsonLines([
        {
          sessionId: 'claude-session',
          isSidechain: true,
          agentId: 'abc123',
          timestamp: '2026-07-04T04:01:00.000Z',
          type: 'user',
          message: { content: [{ type: 'text', text: 'Subagent task prompt' }] }
        }
      ]),
      41
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    // Only the parent session surfaces; the subagent transcript would carry
    // the parent's sessionId and list as a phantom top-level row.
    expect(result.sessions.map((session) => session.filePath)).toEqual([
      '/home/ada/.claude/projects/repo/claude-session.jsonl'
    ])
  })

  it('counts remote sibling subagent transcripts for zero-turn Claude sessions', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.claude/projects/repo/lost-session.jsonl',
      jsonLines([{ type: 'mode', mode: 'default', sessionId: 'lost-session' }]),
      50
    )
    provider.addFile(
      '/home/ada/.claude/projects/repo/lost-session/subagents/agent-a.jsonl',
      jsonLines([{ type: 'user', message: { role: 'user', content: 'Subtask A' } }]),
      51
    )
    provider.addFile(
      '/home/ada/.claude/projects/repo/lost-session/subagents/agent-b.jsonl',
      jsonLines([{ type: 'user', message: { role: 'user', content: 'Subtask B' } }]),
      52
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    // Subagent transcripts must not surface as standalone sessions; they only
    // contribute recoverable signal to their zero-turn parent.
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'claude',
      sessionId: 'lost-session',
      messageCount: 0,
      subagentTranscriptCount: 2,
      filePath: '/home/ada/.claude/projects/repo/lost-session.jsonl'
    })
  })

  it('counts remote subagent siblings for Claude sessions with real turns', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      '/home/ada/.claude/projects/repo/live-session.jsonl',
      jsonLines([
        {
          sessionId: 'live-session',
          type: 'user',
          message: { content: [{ type: 'text', text: 'Do the thing' }] }
        }
      ]),
      60
    )
    provider.addFile(
      '/home/ada/.claude/projects/repo/live-session/subagents/agent-a.jsonl',
      jsonLines([{ type: 'user', message: { role: 'user', content: 'Subtask' } }]),
      61
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    // The walk listing supplies the count for every session (the row badge),
    // not only zero-turn recoverable ones.
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'live-session',
      messageCount: 1,
      subagentTranscriptCount: 1
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

  it('loads Antigravity workspace history with Windows remote paths', async () => {
    const provider = new MemoryRemoteProvider()
    const sessionId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb'
    provider.addFile(
      `C:/Users/Ada/.gemini/antigravity-cli/brain/${sessionId}/.system_generated/logs/transcript.jsonl`,
      jsonLines([
        {
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-07-15T11:39:10.000Z',
          content: '<USER_REQUEST>Windows Antigravity title</USER_REQUEST>'
        }
      ]),
      30
    )
    provider.addFile(
      'C:/Users/Ada/.gemini/antigravity-cli/history.jsonl',
      jsonLines([
        {
          display: 'Windows Antigravity title',
          timestamp: Date.parse('2026-07-15T11:39:10.100Z'),
          workspace: 'C:/repo/app'
        }
      ]),
      31
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:win-box',
      remoteHome: 'C:/Users/Ada',
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions[0]).toMatchObject({
      agent: 'antigravity',
      sessionId,
      cwd: 'C:/repo/app',
      executionHostPlatform: 'win32'
    })
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

function codexTranscript(args: {
  sessionId: string
  title: string
  cwd: string
  timestamp: string
  threadSource?: string
}): string {
  return jsonLines([
    {
      timestamp: args.timestamp,
      type: 'session_meta',
      payload: {
        id: args.sessionId,
        cwd: args.cwd,
        ...(args.threadSource ? { thread_source: args.threadSource } : {})
      }
    },
    {
      timestamp: args.timestamp.replace(':00.000Z', ':01.000Z'),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: args.title }]
      }
    }
  ])
}
