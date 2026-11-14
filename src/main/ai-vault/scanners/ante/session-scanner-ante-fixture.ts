import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Kept beside the parser: the shared fixture module sits at the lint line budget.
const ANTE_FIXTURE_SESSION_ID = 'ante-session'

const ANTE_PROMPT = `Ante vault title

<folder-structure>
- /tmp/ante/
</folder-structure>`

/**
 * Ante lists one folder per session: `meta.json` carries identity, `events.jsonl` the transcript.
 * The subagent transcript below has no `meta.json`, which is what keeps it out of the row list.
 */
export async function writeAnteScannerFixture(sessionsDir: string): Promise<string> {
  const sessionDir = join(sessionsDir, ANTE_FIXTURE_SESSION_ID)
  const subagentDir = join(sessionDir, 'subagents', 'suba_1')
  await mkdir(subagentDir, { recursive: true })
  const metadataFile = join(sessionDir, 'meta.json')
  await writeFile(
    metadataFile,
    JSON.stringify({
      id: ANTE_FIXTURE_SESSION_ID,
      provider: 'ante',
      model: 'ante-model',
      dir: '/tmp/ante',
      first_user_message: ANTE_PROMPT,
      // Ante counts every turn here, so it outranks the transcript variants the row previews.
      message_count: 4,
      usage: { input_tokens: 7, output_tokens: 3 },
      started_time: '2026-05-01T10:11:00.000000Z',
      last_active_time: '2026-05-01T10:11:02.000000Z'
    })
  )
  await writeFile(
    join(sessionDir, 'events.jsonl'),
    `${[
      {
        timestamp: '2026-05-01T10:11:00.100000Z',
        id: 'evt_1',
        event: { UserInput: ANTE_PROMPT }
      },
      {
        timestamp: '2026-05-01T10:11:01.000000Z',
        id: 'evt_2',
        event: { ToolStart: { id: 'call_1', name: 'Bash', args: { command: 'ls' } } }
      },
      {
        timestamp: '2026-05-01T10:11:02.000000Z',
        id: 'evt_3',
        event: { AgentMessage: 'Ante answer' }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  await writeFile(
    join(subagentDir, 'events.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-05-01T10:11:03.000000Z',
      id: 'evt_4',
      event: { UserInput: 'subagent' }
    })}\n`
  )
  return metadataFile
}
