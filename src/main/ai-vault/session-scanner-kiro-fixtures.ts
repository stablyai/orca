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
