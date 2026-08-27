import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { resetCodexSessionIndexTitleCacheForTests } from './session-scanner-codex-title-index'

let tempRoots: string[] = []

afterEach(async () => {
  resetCodexSessionIndexTitleCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('scanAiVaultSessions Codex worker sessions', () => {
  it('hides Codex worker transcripts from session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-workers-'))
    tempRoots.push(root)
    const codexSessionsDir = join(root, 'codex-sessions')
    await mkdir(join(codexSessionsDir, '2026', '06', '12'), { recursive: true })

    await writeFile(
      join(codexSessionsDir, '2026', '06', '12', 'rollout-user-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'user-session',
            cwd: '/repo/app',
            thread_source: 'user'
          }
        },
        {
          timestamp: '2026-06-12T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Top-level Codex task' }]
          }
        }
      ])
    )

    await writeFile(
      join(codexSessionsDir, '2026', '06', '12', 'rollout-worker-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:01:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'worker-session',
            cwd: '/repo/app',
            thread_source: 'subagent'
          }
        },
        {
          timestamp: '2026-06-12T10:01:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Internal worker task' }]
          }
        }
      ])
    )

    await writeFile(
      join(codexSessionsDir, '2026', '06', '12', 'rollout-legacy-worker-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:02:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'legacy-worker-session',
            cwd: '/repo/app',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'user-session',
                  depth: 1,
                  agent_nickname: 'Worker'
                }
              }
            }
          }
        },
        {
          timestamp: '2026-06-12T10:02:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Legacy internal worker task' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      claudeProjectsDir: join(root, 'claude-projects'),
      codexSessionsDir,
      geminiSessionsDir: join(root, 'gemini-sessions'),
      antigravityBrainDir: join(root, 'antigravity-brain'),
      copilotSessionsDir: join(root, 'copilot-sessions'),
      cursorProjectsDir: join(root, 'cursor-projects'),
      opencodeStorageDir: join(root, 'opencode-storage'),
      opencodeDbPaths: [],
      grokSessionsDir: join(root, 'grok-sessions'),
      devinTranscriptsDir: join(root, 'devin-transcripts'),
      hermesSessionsDir: join(root, 'hermes-sessions'),
      rovoSessionsDir: join(root, 'rovo-sessions'),
      openclawStateDir: join(root, 'openclaw-state'),
      openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
      piSessionsDir: join(root, 'pi-sessions'),
      ompSessionsDir: join(root, 'omp-sessions'),
      primeAgentSessionsDir: join(root, 'prime-agent-sessions'),
      droidSessionsDir: join(root, 'droid-sessions'),
      droidProjectsDir: join(root, 'droid-projects'),
      kimiSessionsDir: join(root, 'kimi-sessions'),
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['user-session'])
    expect(result.sessions[0]?.title).toBe('Top-level Codex task')
  })

  it('keeps a user Codex transcript that later embeds a worker session_meta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-embedded-worker-'))
    tempRoots.push(root)
    const codexHome = join(root, 'codex-home')
    const codexSessionsDir = join(codexHome, 'sessions', '2026', '08', '15')
    await mkdir(codexSessionsDir, { recursive: true })

    await writeFile(
      join(codexSessionsDir, 'rollout-user-with-embedded-worker.jsonl'),
      jsonLines([
        {
          timestamp: '2026-08-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'user-parent',
            cwd: '/repo/ads_public',
            thread_source: 'user',
            source: 'vscode'
          }
        },
        {
          timestamp: '2026-08-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Parent brand task' }]
          }
        },
        {
          timestamp: '2026-08-15T10:00:02.000Z',
          type: 'session_meta',
          payload: {
            id: 'embedded-worker',
            cwd: '/repo/ads_public',
            thread_source: 'subagent',
            source: {
              subagent: {
                thread_spawn: { parent_thread_id: 'user-parent', depth: 1 }
              }
            }
          }
        },
        {
          timestamp: '2026-08-15T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Still the parent conversation' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...emptyAgentRoots(root),
      codexSessionsDir: join(codexHome, 'sessions'),
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['user-parent'])
    expect(result.sessions[0]?.title).toBe('Parent brand task')
  })

  it('lists a Codex worker session that the user renamed in session_index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-named-worker-'))
    tempRoots.push(root)
    const codexHome = join(root, 'codex-home')
    const liveDir = join(codexHome, 'sessions', '2026', '08', '14')
    const archivedDir = join(codexHome, 'archived_sessions')
    await mkdir(liveDir, { recursive: true })
    await mkdir(archivedDir, { recursive: true })

    await writeFile(
      join(liveDir, 'rollout-named-worker.jsonl'),
      jsonLines([
        {
          timestamp: '2026-08-14T05:00:08.000Z',
          type: 'session_meta',
          payload: {
            id: 'named-worker',
            cwd: '/repo/ads_public',
            thread_source: 'subagent'
          }
        },
        {
          timestamp: '2026-08-14T05:00:09.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: '<codex_delegation> brand task' }]
          }
        }
      ])
    )
    await writeFile(
      join(archivedDir, 'rollout-archived-named-worker.jsonl'),
      jsonLines([
        {
          timestamp: '2026-08-14T05:00:24.000Z',
          type: 'session_meta',
          payload: {
            id: 'archived-named-worker',
            cwd: '/repo/ads_public',
            thread_source: 'subagent'
          }
        },
        {
          timestamp: '2026-08-14T05:00:25.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: '<codex_delegation> archived brand task' }]
          }
        }
      ])
    )
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'named-worker', thread_name: 'ads: MERACH US' })}\n${JSON.stringify({ id: 'archived-named-worker', thread_name: 'ads: Bluetti Power US' })}\n`
    )

    const result = await scanAiVaultSessions({
      ...emptyAgentRoots(root),
      codexSessionsDir: join(codexHome, 'sessions'),
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'archived-named-worker',
      'named-worker'
    ])
    expect(result.sessions.find((session) => session.sessionId === 'named-worker')?.title).toBe(
      'ads: MERACH US'
    )
    expect(
      result.sessions.find((session) => session.sessionId === 'archived-named-worker')?.title
    ).toBe('ads: Bluetti Power US')
  })
})

function emptyAgentRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    antigravityBrainDir: join(root, 'antigravity-brain'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    opencodeDbPaths: [] as string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    ompSessionsDir: join(root, 'omp-sessions'),
    primeAgentSessionsDir: join(root, 'prime-agent-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions')
  }
}
