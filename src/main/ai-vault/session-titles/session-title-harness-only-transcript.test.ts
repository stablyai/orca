import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'

const SESSION_ID = '4bacae20-42e2-420c-9e44-af14ffc469f3'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function userTurn(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: SESSION_ID,
    cwd: '/repo/app',
    timestamp: '2026-11-08T10:00:00.000Z',
    ...extra,
    message: { role: 'user', content }
  }
}

const CLEARED_SESSION = [
  { type: 'mode', sessionId: SESSION_ID },
  userTurn(
    '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>',
    { isMeta: true }
  ),
  userTurn(
    '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'
  )
]

async function readTitle(records: Record<string, unknown>[]): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), 'orca-harness-title-'))
  roots.push(root)
  const transcriptPath = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const result = await readAiVaultSessionTitlesFromFiles([
    { agent: 'claude', sessionId: SESSION_ID, transcriptPath }
  ])
  return result.titles
}

describe('session titles for a Claude session right after /clear', () => {
  it('gives the tab no title while only harness turns exist', async () => {
    expect(await readTitle(CLEARED_SESSION)).toEqual([])
  })

  it('names the session from the first real prompt after /clear', async () => {
    expect(await readTitle([...CLEARED_SESSION, userTurn('Fix the login redirect')])).toEqual([
      { agent: 'claude', sessionId: SESSION_ID, title: 'Fix the login redirect', kind: 'fallback' }
    ])
  })
})
