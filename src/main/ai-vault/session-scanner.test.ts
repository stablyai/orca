import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

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

  it('captures an in-progress OMP model from model_change before any assistant reply', async () => {
    // OMP writes the model on `model_change.model` (not Pi's `modelId`). With no
    // assistant message yet, the model must still come through — proving the
    // model_change fallback rather than assistant-message capture.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-omp-mc-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(roots.ompSessionsDir, { recursive: true })
    await writeFile(
      join(roots.ompSessionsDir, 'omp-in-progress.jsonl'),
      jsonLines([
        {
          type: 'session',
          id: 'omp-in-progress',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/tmp/omp'
        },
        { type: 'model_change', model: 'omp-mc-only-model', timestamp: '2026-05-01T10:00:01.000Z' },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:02.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] }
        }
      ])
    )

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 5 })
    const session = result.sessions.find((s) => s.agent === 'omp')
    expect(session?.model).toBe('omp-mc-only-model')
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
