import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'

let tempRoots: string[] = []

afterEach(async () => {
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
            parent_thread_id: 'user-session',
            agent_nickname: 'Worker',
            agent_path: '/root/legacy_worker',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'user-session',
                  depth: 1,
                  agent_nickname: 'Worker',
                  agent_role: null,
                  agent_path: '/root/legacy_worker'
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

    await writeFile(
      join(codexSessionsDir, '2026', '06', '12', 'rollout-nested-worker-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:03:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'nested-worker-session',
            cwd: '/repo/app',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'legacy-worker-session',
                  depth: 2,
                  agent_nickname: 'Nested',
                  agent_role: 'explorer',
                  agent_path: '/root/legacy_worker/nested'
                }
              }
            }
          }
        },
        {
          timestamp: '2026-06-12T10:03:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Nested internal worker task' }]
          }
        }
      ])
    )

    // `review` is a sibling tag of `thread_spawn` in the same union, not an
    // older spelling of it: it states no spawn record, so the parent is on the
    // payload's own key. `thread_source` is omitted because some releases state
    // none, and it is the only other signal that would keep this transcript out
    // of the user's history.
    await writeFile(
      join(codexSessionsDir, '2026', '06', '12', 'rollout-role-only-worker-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:04:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'role-only-worker-session',
            cwd: '/repo/app',
            parent_thread_id: 'user-session',
            source: { subagent: 'review' }
          }
        },
        {
          timestamp: '2026-06-12T10:04:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Role-only internal worker task' }]
          }
        }
      ])
    )

    // A compaction thread is a non-user thread that names no parent at all,
    // so its tag is the only thing keeping it out of the user's history.
    await writeFile(
      join(codexSessionsDir, '2026', '06', '12', 'rollout-compaction-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:05:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'compaction-session',
            cwd: '/repo/app',
            source: { subagent: 'compact' }
          }
        },
        {
          timestamp: '2026-06-12T10:05:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Compaction of the user session' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      claudeProjectsDir: join(root, 'claude-projects'),
      openclaudeProjectsDir: join(root, 'openclaude-projects'),
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
      museSessionsDir: join(root, 'muse-sessions'),
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['user-session'])
    expect(result.sessions[0]?.title).toBe('Top-level Codex task')
  })
})
