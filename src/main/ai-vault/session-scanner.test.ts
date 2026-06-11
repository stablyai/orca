import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VAULT_AGENTS, buildAiVaultResumeCommand } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function isolatedScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects')
  }
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('scanAiVaultSessions', () => {
  it('indexes Claude and Codex transcripts with resume commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const claudeRoot = roots.claudeProjectsDir
    const codexRoot = roots.codexSessionsDir
    await mkdir(join(claudeRoot, 'project'), { recursive: true })
    await mkdir(join(codexRoot, '2026', '05', '01'), { recursive: true })

    await writeFile(
      join(claudeRoot, 'project', 'claude-session.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/repo/app',
          gitBranch: 'feature/vault',
          isMeta: false,
          message: { role: 'user', content: 'Implement the vault panel' }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:02:00.000Z',
          cwd: '/repo/app',
          gitBranch: 'feature/vault',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5
            }
          }
        }),
        JSON.stringify({
          type: 'custom-title',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:03:00.000Z',
          customTitle: 'Vault polish pass'
        })
      ].join('\n')
    )

    await writeFile(
      join(
        codexRoot,
        '2026',
        '05',
        '01',
        'rollout-2026-05-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
      ),
      [
        JSON.stringify({
          timestamp: '2026-05-01T11:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: '019f0000-1111-7222-8333-444444444444',
            cwd: '/repo/app/packages/web',
            git: { branch: 'feature/codex-vault' }
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'text', text: '# AGENTS.md instructions for /repo/app <INSTRUCTIONS>' }
            ]
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Fix the resume picker filters' }]
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:03.000Z',
          type: 'turn_context',
          payload: { cwd: '/repo/app/packages/web', model: 'gpt-5.3-codex' }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:04.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 500,
                cached_input_tokens: 100,
                output_tokens: 125,
                reasoning_output_tokens: 25,
                total_tokens: 625
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: '2026-05-01T11:00:05.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 500,
                cached_input_tokens: 100,
                output_tokens: 125,
                reasoning_output_tokens: 25,
                total_tokens: 625
              }
            }
          }
        })
      ].join('\n')
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Fix the resume picker filters',
      'Vault polish pass'
    ])

    const claude = result.sessions.find((session) => session.agent === 'claude')
    expect(claude).toMatchObject({
      sessionId: 'claude-session',
      cwd: '/repo/app',
      branch: 'feature/vault',
      model: 'claude-sonnet-4-5',
      messageCount: 2,
      totalTokens: 155,
      resumeCommand: "cd '/repo/app' && claude --resume 'claude-session'"
    })

    const codex = result.sessions.find((session) => session.agent === 'codex')
    expect(codex).toMatchObject({
      sessionId: '019f0000-1111-7222-8333-444444444444',
      cwd: '/repo/app/packages/web',
      branch: 'feature/codex-vault',
      model: 'gpt-5.3-codex',
      messageCount: 2,
      totalTokens: 625,
      resumeCommand: `cd '/repo/app/packages/web' && CODEX_HOME='${root}' codex resume '019f0000-1111-7222-8333-444444444444'`
    })
  })

  it('indexes Codex sessions from Orca runtime homes with resumable commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-runtime-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const runtimeHome = join(root, 'codex-runtime-home', 'home')
    const runtimeSessionsDir = join(runtimeHome, 'sessions')
    await mkdir(join(runtimeSessionsDir, '2026', '06', '04'), { recursive: true })

    await writeFile(
      join(
        runtimeSessionsDir,
        '2026',
        '06',
        '04',
        'rollout-2026-06-04T23-58-22-019e9693-64fc-7370-9c18-7e625c595d0f.jsonl'
      ),
      jsonLines([
        {
          timestamp: '2026-06-04T23:58:22.000Z',
          type: 'session_meta',
          payload: {
            id: '019e9693-64fc-7370-9c18-7e625c595d0f',
            cwd: '/Users/nwparker/orca/workspaces/orca/mem4'
          }
        },
        {
          timestamp: '2026-06-04T23:58:23.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Resume this managed Codex session' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      additionalCodexSessionsDirs: [runtimeSessionsDir],
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'codex',
      sessionId: '019e9693-64fc-7370-9c18-7e625c595d0f',
      cwd: '/Users/nwparker/orca/workspaces/orca/mem4',
      codexHome: runtimeHome,
      resumeCommand: `cd '/Users/nwparker/orca/workspaces/orca/mem4' && CODEX_HOME='${runtimeHome}' codex resume '019e9693-64fc-7370-9c18-7e625c595d0f'`
    })
  })

  it('indexes every supported agent transcript format with native resume commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-all-agents-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)

    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })
    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'claude-session.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'claude-session',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/tmp/claude',
          message: { role: 'user', content: 'Claude title' }
        }
      ])
    )

    await mkdir(join(roots.codexSessionsDir, '2026', '05', '01'), { recursive: true })
    await writeFile(
      join(roots.codexSessionsDir, '2026', '05', '01', 'rollout-2026-codex-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-05-01T10:01:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-session', cwd: '/tmp/codex' }
        },
        {
          timestamp: '2026-05-01T10:01:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Codex title' }]
          }
        }
      ])
    )

    await mkdir(roots.geminiSessionsDir, { recursive: true })
    await writeFile(
      join(roots.geminiSessionsDir, 'gemini-session.json'),
      JSON.stringify({
        sessionId: 'gemini-session',
        startTime: '2026-05-01T10:02:00.000Z',
        lastUpdated: '2026-05-01T10:02:01.000Z',
        messages: [
          {
            type: 'user',
            timestamp: '2026-05-01T10:02:00.000Z',
            content: [{ text: 'Gemini title' }]
          },
          {
            type: 'gemini',
            timestamp: '2026-05-01T10:02:01.000Z',
            model: 'gemini-2.5-pro',
            tokens: { input: 10, output: 5 }
          }
        ]
      })
    )

    await mkdir(roots.copilotSessionsDir, { recursive: true })
    await writeFile(
      join(roots.copilotSessionsDir, 'copilot-session.jsonl'),
      jsonLines([
        {
          type: 'session.start',
          data: { sessionId: 'copilot-session', startTime: '2026-05-01T10:03:00.000Z' },
          timestamp: '2026-05-01T10:03:00.000Z'
        },
        {
          type: 'session.info',
          data: {
            infoType: 'folder_trust',
            message: 'Folder /tmp/copilot has been added to trusted folders.'
          },
          timestamp: '2026-05-01T10:03:01.000Z'
        },
        {
          type: 'user.message',
          data: { transformedContent: 'Copilot title' },
          timestamp: '2026-05-01T10:03:02.000Z'
        }
      ])
    )

    await mkdir(join(roots.cursorProjectsDir, 'project', 'agent-transcripts'), { recursive: true })
    await writeFile(
      join(roots.cursorProjectsDir, 'project', 'agent-transcripts', 'cursor-session.jsonl'),
      jsonLines([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Cursor title' }] }
        },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }
      ])
    )

    await mkdir(join(roots.opencodeStorageDir, 'session', 'project'), { recursive: true })
    await mkdir(join(roots.opencodeStorageDir, 'message', 'opencode-session'), { recursive: true })
    await writeFile(
      join(roots.opencodeStorageDir, 'session', 'project', 'ses_opencode.json'),
      JSON.stringify({
        id: 'opencode-session',
        directory: '/tmp/opencode',
        title: 'OpenCode title',
        time: { created: 1_777_634_000_000, updated: 1_777_634_001_000 }
      })
    )
    await writeFile(
      join(roots.opencodeStorageDir, 'message', 'opencode-session', 'msg_1.json'),
      JSON.stringify({
        role: 'user',
        summary: { title: 'OpenCode title' },
        time: { created: 1_777_634_000_000 },
        tokens: { input: 7, output: 3 }
      })
    )

    await mkdir(roots.hermesSessionsDir, { recursive: true })
    await writeFile(
      join(roots.hermesSessionsDir, 'session_hermes-session.json'),
      JSON.stringify({
        session_id: 'hermes-session',
        model: 'hermes-1',
        cwd: '/tmp/hermes',
        session_start: '2026-05-01T10:05:00.000Z',
        last_updated: '2026-05-01T10:05:01.000Z',
        messages: [{ role: 'user', content: 'Hermes title' }]
      })
    )

    await mkdir(join(roots.rovoSessionsDir, 'rovo-session'), { recursive: true })
    await writeFile(
      join(roots.rovoSessionsDir, 'rovo-session', 'metadata.json'),
      JSON.stringify({ title: 'Rovo title', workspace_path: '/tmp/rovo' })
    )
    await writeFile(
      join(roots.rovoSessionsDir, 'rovo-session', 'session_context.json'),
      JSON.stringify({
        message_history: [
          {
            kind: 'request',
            timestamp: '2026-05-01T10:06:00.000Z',
            parts: [{ part_kind: 'user-prompt', content: 'Rovo title' }]
          }
        ]
      })
    )

    await mkdir(join(roots.openclawStateDir, 'agents', 'default', 'sessions'), { recursive: true })
    await writeFile(
      join(roots.openclawStateDir, 'agents', 'default', 'sessions', 'openclaw-session.jsonl'),
      jsonLines([
        {
          type: 'session',
          id: 'openclaw-session',
          timestamp: '2026-05-01T10:07:00.000Z',
          cwd: '/tmp/openclaw'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:07:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'OpenClaw title' }] }
        }
      ])
    )

    await mkdir(roots.piSessionsDir, { recursive: true })
    await writeFile(
      join(roots.piSessionsDir, 'pi-session.jsonl'),
      jsonLines([
        {
          type: 'session',
          id: 'pi-session',
          timestamp: '2026-05-01T10:08:00.000Z',
          cwd: '/tmp/pi'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:08:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Pi title' }] }
        }
      ])
    )

    await mkdir(roots.droidSessionsDir, { recursive: true })
    await writeFile(
      join(roots.droidSessionsDir, 'droid-session.jsonl'),
      jsonLines([
        {
          type: 'system',
          session_id: 'droid-session',
          timestamp: '2026-05-01T10:09:00.000Z',
          model: 'droid-model',
          cwd: '/tmp/droid'
        },
        {
          type: 'message',
          session_id: 'droid-session',
          timestamp: '2026-05-01T10:09:01.000Z',
          role: 'user',
          text: 'Droid title'
        },
        {
          type: 'completion',
          session_id: 'droid-session',
          timestamp: '2026-05-01T10:09:02.000Z',
          usage: { input_tokens: 2, output_tokens: 3 }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 20
    })

    expect(result.issues).toEqual([])
    expect(new Set(result.sessions.map((session) => session.agent))).toEqual(
      new Set(AI_VAULT_AGENTS)
    )

    const commandByAgent = new Map(
      result.sessions.map((session) => [session.agent, session.resumeCommand])
    )
    expect(commandByAgent.get('claude')).toBe(
      "cd '/tmp/claude' && claude --resume 'claude-session'"
    )
    expect(commandByAgent.get('codex')).toBe(
      `cd '/tmp/codex' && CODEX_HOME='${root}' codex resume 'codex-session'`
    )
    expect(commandByAgent.get('gemini')).toBe("gemini --resume 'gemini-session'")
    expect(commandByAgent.get('copilot')).toBe(
      "cd '/tmp/copilot' && copilot --resume='copilot-session'"
    )
    expect(commandByAgent.get('cursor')).toBe("cursor-agent --resume 'cursor-session'")
    expect(commandByAgent.get('opencode')).toBe(
      "cd '/tmp/opencode' && opencode --session 'opencode-session'"
    )
    expect(commandByAgent.get('hermes')).toBe(
      "cd '/tmp/hermes' && hermes --resume 'hermes-session'"
    )
    expect(commandByAgent.get('rovo')).toBe(
      "cd '/tmp/rovo' && acli rovodev run --restore 'rovo-session'"
    )
    expect(commandByAgent.get('openclaw')).toBe(
      "cd '/tmp/openclaw' && openclaw --resume 'openclaw-session'"
    )
    expect(commandByAgent.get('pi')).toBe("cd '/tmp/pi' && pi --session 'pi-session'")
    expect(commandByAgent.get('droid')).toBe("cd '/tmp/droid' && droid --resume 'droid-session'")
  })
})

describe('buildAiVaultResumeCommand', () => {
  it('wraps Windows cwd changes in cmd so PowerShell and cmd launch the same resume command', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32'
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\Users\\Ada Lovelace\\repo"" && codex resume ""session-1"""')
  })

  it('carries non-default Codex homes in copied resume commands', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: '/repo/app',
        platform: 'darwin',
        codexHome: '/Users/ada/Library/Application Support/Orca/codex-runtime-home/home'
      })
    ).toBe(
      "cd '/repo/app' && CODEX_HOME='/Users/ada/Library/Application Support/Orca/codex-runtime-home/home' codex resume 'session-1'"
    )

    expect(
      buildAiVaultResumeCommand({
        agent: 'codex',
        sessionId: 'session-1',
        cwd: 'C:\\Users\\Ada Lovelace\\repo',
        platform: 'win32',
        codexHome: 'C:\\Users\\Ada\\AppData\\Roaming\\Orca\\codex-runtime-home\\home'
      })
    ).toBe(
      'cmd /d /s /c "cd /d ""C:\\Users\\Ada Lovelace\\repo"" && set ""CODEX_HOME=C:\\Users\\Ada\\AppData\\Roaming\\Orca\\codex-runtime-home\\home"" && codex resume ""session-1"""'
    )
  })
})
