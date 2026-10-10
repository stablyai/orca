import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

export const KIRO_FIXTURE_SESSION_ID = '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'

/** Kiro CLI's flat layout: `<id>.json` metadata beside its `<id>.jsonl` transcript. */
export async function writeKiroSessionFixture(
  roots: ReturnType<typeof isolatedScanRoots>
): Promise<void> {
  const dir = roots.kiroSessionsDir
  await mkdir(join(dir, KIRO_FIXTURE_SESSION_ID, 'tasks'), { recursive: true })
  await writeFile(
    join(dir, `${KIRO_FIXTURE_SESSION_ID}.json`),
    JSON.stringify({
      session_id: KIRO_FIXTURE_SESSION_ID,
      cwd: '/tmp/kiro',
      created_at: '2026-05-01T10:13:00.000000000Z',
      updated_at: '2026-05-01T10:13:02.000000000Z',
      title: 'Kiro title',
      session_created_reason: 'subagent',
      session_state: { rts_model_state: { model_info: { model_id: 'kiro-model' } } }
    })
  )
  await writeJsonlFile(join(dir, `${KIRO_FIXTURE_SESSION_ID}.jsonl`), [
    {
      version: 'v1',
      kind: 'Prompt',
      data: { content: [{ kind: 'text', data: 'Kiro title' }], meta: { timestamp: 1777630381 } }
    },
    {
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        content: [
          { kind: 'thinking', data: { text: 'hidden reasoning' } },
          { kind: 'toolUse', data: { toolUseId: 't1', name: 'read', input: { path: 'a.txt' } } }
        ]
      }
    },
    {
      version: 'v1',
      kind: 'ToolResults',
      data: {
        content: [
          { kind: 'toolResult', data: { toolUseId: 't1', content: [{ kind: 'text', data: 'a' }] } }
        ]
      }
    },
    {
      version: 'v1',
      kind: 'AssistantMessage',
      data: { content: [{ kind: 'text', data: 'Kiro reply' }] }
    }
  ])
}

export const KIRO_V3_FIXTURE_SESSION_ID = 'sess_dc17e658-cf15-4822-80df-0f356f21879a'

// Mirrors the session.json kiro-cli 2.27.0 writes for a V3 `work` session.
export const KIRO_V3_FIXTURE_MANIFEST = {
  schemaVersion: '1',
  id: KIRO_V3_FIXTURE_SESSION_ID,
  title: 'Execute PowerShell Sleep Command',
  agentMode: 'work',
  workspacePaths: ['/private/tmp/kiro-test-proj'],
  createdAt: '2026-10-02T16:04:12.112Z',
  lastModifiedAt: '2026-10-02T16:04:35.400Z',
  modelId: 'claude-opus-5.5'
}

// Mirrors messages.jsonl: one record per line with the turn content under `payload`.
export const KIRO_V3_FIXTURE_MESSAGES = [
  { id: 'm1', timestamp: '2026-10-02T16:04:12.200Z', payload: { type: 'session_start' } },
  {
    id: 'm2',
    timestamp: '2026-10-02T16:04:12.300Z',
    payload: { type: 'user', content: 'Run the shell command: echo dev-ok', images: [] }
  },
  {
    id: 'm3',
    timestamp: '2026-10-02T16:04:13.000Z',
    payload: { type: 'assistant', operationType: 'Reasoning', content: 'thinking about it' }
  },
  {
    id: 'm4',
    timestamp: '2026-10-02T16:04:14.000Z',
    payload: { type: 'tool_call', executionId: 'e1' }
  },
  {
    id: 'm5',
    timestamp: '2026-10-02T16:04:30.000Z',
    payload: { type: 'assistant', operationType: 'Say', content: 'done' }
  },
  {
    id: 'm6',
    timestamp: '2026-10-02T16:04:31.000Z',
    payload: { type: 'assistant', operationType: 'Summary', content: 'conversation summary' }
  }
]

/**
 * The V3 engine's layout: `<workspace-hash>/sess_<uuid>/session.json` beside `messages.jsonl`.
 * `messageLines: null` leaves the transcript out. Returns the manifest path.
 */
export async function writeKiroV3SessionFixture(
  sessionsDir: string,
  options: {
    manifest?: Record<string, unknown>
    messageLines?: Record<string, unknown>[] | null
  } = {}
): Promise<string> {
  const sessionDir = join(sessionsDir, '5fab923ac92fb45c', KIRO_V3_FIXTURE_SESSION_ID)
  await mkdir(sessionDir, { recursive: true })
  const manifestPath = join(sessionDir, 'session.json')
  await writeFile(manifestPath, JSON.stringify(options.manifest ?? KIRO_V3_FIXTURE_MANIFEST))
  const lines = options.messageLines === undefined ? KIRO_V3_FIXTURE_MESSAGES : options.messageLines
  if (lines) {
    await writeJsonlFile(join(sessionDir, 'messages.jsonl'), lines)
  }
  return manifestPath
}
