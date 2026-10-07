import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAntigravityScannerFixture } from './session-scanner-test-fixtures'
import { jsonlBody, type AgentVaultRoots } from './session-scanner-vault-roots'

// The agents whose session is a JSON document, or a directory of them, rewritten
// in place rather than appended to. Antigravity rides along here because its
// fixture writer already owns the layout.

/**
 * Write one session per document-shaped agent.
 * @param root - The vault root, which Kimi's session index lives directly in.
 * @param roots - The scan roots to write under.
 * @param antigravitySessionId - The conversation id Antigravity resumes by.
 */
export async function writeDocumentAgentFixtures(
  root: string,
  roots: AgentVaultRoots,
  antigravitySessionId: string
): Promise<void> {
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

  await writeAntigravityScannerFixture(roots.antigravityBrainDir, antigravitySessionId)

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
    jsonlBody([
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

  const clineSessionId = 'cline-session'
  const clineSessionDir = join(roots.clineSessionsDir, clineSessionId)
  await mkdir(clineSessionDir, { recursive: true })
  await writeFile(
    join(clineSessionDir, `${clineSessionId}.json`),
    JSON.stringify({
      session_id: clineSessionId,
      started_at: '2026-05-01T10:10:30.000Z',
      model: 'cline-model',
      cwd: '/tmp/cline'
    })
  )
  await writeFile(
    join(clineSessionDir, `${clineSessionId}.messages.json`),
    JSON.stringify({
      updated_at: '2026-05-01T10:10:31.000Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Cline vault title' }] }]
    })
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
    jsonlBody([
      { sessionId: 'session_kimi-session', sessionDir: kimiSessionDir, workDir: '/tmp/kimi' }
    ])
  )
  await writeFile(
    join(kimiSessionDir, 'agents', 'main', 'wire.jsonl'),
    jsonlBody([
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
}
