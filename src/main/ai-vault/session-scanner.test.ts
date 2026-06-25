import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENTS, buildAiVaultResumeCommand } from '../../shared/ai-vault-types'
import { scanAiVaultSessions } from './session-scanner'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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
    // Why: prevent the SQLite scanner from picking up the real
    // ~/.local/share/opencode/opencode.db during tests.
    opencodeDbPaths: [] as readonly string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions')
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
              { type: 'text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>repo policy' }
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
    await writeFile(
      join(root, 'session_index.jsonl'),
      jsonLines([
        {
          id: '019f0000-1111-7222-8333-444444444444',
          thread_name: 'Indexed Codex resume picker title'
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Indexed Codex resume picker title',
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

  it('indexes WSL home session roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-wsl-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const wslHome = join(root, 'wsl', 'Ubuntu', 'home', 'ada')
    await mkdir(join(wslHome, '.claude', 'projects', 'repo'), { recursive: true })
    await mkdir(
      join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home', 'sessions'),
      {
        recursive: true
      }
    )

    await writeFile(
      join(wslHome, '.claude', 'projects', 'repo', 'claude-wsl.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'claude-wsl',
          timestamp: '2026-06-10T10:00:00.000Z',
          cwd: '/home/ada/repo',
          message: { role: 'user', content: 'Claude WSL title' }
        }
      ])
    )
    await writeFile(
      join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home',
        'sessions',
        'codex-wsl.jsonl'
      ),
      jsonLines([
        {
          timestamp: '2026-06-10T10:01:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-wsl', cwd: '/home/ada/repo' }
        },
        {
          timestamp: '2026-06-10T10:01:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Codex WSL title' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      wslHomeDirs: [wslHome],
      platform: 'win32'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Claude WSL title',
      'Codex WSL title'
    ])
    expect(result.sessions.find((session) => session.agent === 'codex')?.codexHome).toBe(
      join(wslHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
    )
  })

  it('skips hidden Codex context blocks when choosing session titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-hidden-context-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.codexSessionsDir, '2026', '06', '11'), { recursive: true })

    await writeFile(
      join(roots.codexSessionsDir, '2026', '06', '11', 'rollout-hidden-context.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-11T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'hidden-context-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-06-11T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<codex_internal_context source="goal">\\nKeep going\\n</codex_internal_context>'
              }
            ]
          }
        },
        {
          timestamp: '2026-06-11T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Fix the title shown in the session list' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBe('Fix the title shown in the session list')
    expect(result.sessions[0]?.previewMessages.map((message) => message.text)).toEqual([
      'Fix the title shown in the session list'
    ])
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

    await mkdir(join(roots.grokSessionsDir, encodeURIComponent('/tmp/grok'), 'grok-session'), {
      recursive: true
    })
    await writeFile(
      join(roots.grokSessionsDir, encodeURIComponent('/tmp/grok'), 'grok-session', 'summary.json'),
      JSON.stringify({
        info: { id: 'grok-session', cwd: '/tmp/grok' },
        session_summary: '',
        created_at: '2026-05-01T10:04:00.000Z',
        updated_at: '2026-05-01T10:04:01.000Z',
        num_chat_messages: 2,
        current_model_id: 'grok-build',
        head_branch: 'feature/grok-vault'
      })
    )
    await writeFile(
      join(
        roots.grokSessionsDir,
        encodeURIComponent('/tmp/grok'),
        'grok-session',
        'chat_history.jsonl'
      ),
      jsonLines([
        {
          type: 'user',
          content: [
            {
              type: 'text',
              text: '<user_info>context</user_info><user_query>Grok title</user_query>'
            }
          ]
        },
        { type: 'assistant', content: 'Done' }
      ])
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

    await mkdir(roots.devinTranscriptsDir, { recursive: true })
    await writeFile(
      join(roots.devinTranscriptsDir, 'devin-session.json'),
      JSON.stringify({
        session_id: 'devin-session',
        working_directory: '/tmp/devin',
        agent: { model_name: 'swe-1-6-fast' },
        steps: [
          {
            metadata: {
              created_at: '2026-05-01T10:10:00.000Z',
              is_user_input: true,
              metrics: { input_tokens: 1, output_tokens: 2 }
            },
            text: 'Devin vault title'
          }
        ]
      })
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

    // Kimi: <sessions>/wd_*/session_*/state.json + sibling agents/main/wire.jsonl,
    // with the work dir resolved from the top-level session_index.jsonl.
    const kimiSessionDir = join(roots.kimiSessionsDir, 'wd_app_abc', 'session_kimi-session')
    await mkdir(join(kimiSessionDir, 'agents', 'main'), { recursive: true })
    await writeFile(
      join(kimiSessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-05-01T10:11:00.000Z',
        updatedAt: '2026-05-01T10:11:05.000Z',
        title: 'Kimi vault title',
        lastPrompt: 'Kimi vault title',
        agents: { main: { type: 'main', parentAgentId: null } }
      })
    )
    await writeFile(
      join(root, 'session_index.jsonl'),
      jsonLines([
        { sessionId: 'session_kimi-session', sessionDir: kimiSessionDir, workDir: '/tmp/kimi' }
      ])
    )
    await writeFile(
      join(kimiSessionDir, 'agents', 'main', 'wire.jsonl'),
      jsonLines([
        { type: 'config.update', modelAlias: 'kimi-k2.6', time: 1781853559132 },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Kimi vault title' }],
            origin: { kind: 'user' }
          },
          time: 1781853559164
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: 'Kimi reply' } },
          time: 1781853559177
        },
        { type: 'context.append_loop_event', event: { type: 'step.end' }, time: 1781853559178 },
        {
          type: 'usage.record',
          model: 'kimi-k2.6',
          usage: { inputOther: 4, output: 6, inputCacheRead: 0, inputCacheCreation: 0 },
          usageScope: 'turn',
          time: 1781853559178
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
    expect(commandByAgent.get('grok')).toBe("cd '/tmp/grok' && grok --resume 'grok-session'")
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
    expect(commandByAgent.get('devin')).toBe("cd '/tmp/devin' && devin --resume 'devin-session'")
    expect(commandByAgent.get('droid')).toBe("cd '/tmp/droid' && droid --resume 'droid-session'")
    expect(commandByAgent.get('kimi')).toBe(
      "cd '/tmp/kimi' && kimi --session 'session_kimi-session'"
    )
  })

  it('strips newline-heavy Grok user_query envelopes without regex matching', async () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-grok-large-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionDir = join(roots.grokSessionsDir, encodeURIComponent('/tmp/grok'), 'large-session')
    const requestText = 'Grok large title\n'.repeat(300)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'summary.json'),
      JSON.stringify({
        info: { id: 'large-session', cwd: '/tmp/grok' },
        created_at: '2026-05-01T10:04:00.000Z'
      })
    )
    await writeFile(
      join(sessionDir, 'chat_history.jsonl'),
      jsonLines([
        {
          type: 'user',
          content: `<USER_INFO>context</USER_INFO><USER_QUERY>\n${requestText}</USER_QUERY>`
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 5
    })

    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.title).toContain('Grok large title')
    expect(result.sessions[0]?.title).not.toContain('USER_QUERY')
    const usedGrokWrapperMatch = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.source.includes('<user_query>') &&
        pattern.source.includes('[\\s\\S]')
    )
    expect(usedGrokWrapperMatch).toBe(false)
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
