import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const EMULATOR_AGENT_HISTORY_TITLE = 'Hybrid Agent History Fixture'
export const EMULATOR_AGENT_HISTORY_SEARCH_MARKER = 'E2E_AGENT_HISTORY_SEARCH_MARKER'
export const EMULATOR_AGENT_HISTORY_PREVIEW_MARKER = 'E2E_AGENT_HISTORY_PREVIEW_MARKER'

const SESSION_ID = '019d0000-1111-7222-8333-444444444444'
const SESSION_FILE = 'rollout-2026-07-26T12-00-00-019d0000-1111-7222-8333-444444444444.jsonl'

export function seedEmulatorAgentHistoryFixture({ homeDir, workspacePath }) {
  const sessionDirectory = path.join(homeDir, '.codex', 'sessions', '2026', '07', '26')
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 })
  const transcriptPath = path.join(sessionDirectory, SESSION_FILE)
  const records = [
    {
      timestamp: '2026-07-26T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        cwd: workspacePath,
        title: EMULATOR_AGENT_HISTORY_TITLE,
        thread_source: 'user'
      }
    },
    {
      timestamp: '2026-07-26T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: EMULATOR_AGENT_HISTORY_SEARCH_MARKER }]
      }
    },
    {
      timestamp: '2026-07-26T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: EMULATOR_AGENT_HISTORY_PREVIEW_MARKER }]
      }
    }
  ]
  writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    mode: 0o600
  })
  return transcriptPath
}
