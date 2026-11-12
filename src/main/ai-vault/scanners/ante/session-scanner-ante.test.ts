import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots } from '../../session-scanner-test-fixtures'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'
import { parseAnteSessionFile } from './session-scanner-ante-parser'
import { writeAnteScannerFixture } from './session-scanner-ante-fixture'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions ante', () => {
  it('lists an Ante session from meta.json with title, cwd, model, tokens and resume command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ante-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const metadataFile = await writeAnteScannerFixture(roots.anteSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    // The subagent transcript has no meta.json, so it must not surface as a second row.
    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.agent).toBe('ante')
    expect(session.sessionId).toBe('ante-session')
    // The injected folder listing is stripped from the opening prompt before it titles a row.
    expect(session.title).toBe('Ante vault title')
    expect(session.cwd).toBe('/tmp/ante')
    expect(session.model).toBe('ante-model')
    expect(session.totalTokens).toBe(10)
    expect(session.filePath).toBe(metadataFile)
    expect(session.resumeCommand).toBe("cd '/tmp/ante' && ante --resume 'ante-session'")
  })

  it('publishes transcript turns and folds event timestamps into the timeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ante-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeAnteScannerFixture(roots.anteSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })
    const session = result.sessions[0]

    // `meta.json` owns the total: folding the preview window must not recount its turns.
    expect(session.messageCount).toBe(4)
    expect(session.previewMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(session.previewMessages[1]?.text).toBe('Ante answer')
    expect(session.createdAt).toBe('2026-05-01T10:11:00.000Z')
    expect(session.updatedAt).toBe('2026-05-01T10:11:02.000Z')
  })

  it('lists a session whose transcript is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ante-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await writeAnteScannerFixture(roots.anteSessionsDir)
    await rm(join(roots.anteSessionsDir, 'ante-session', 'events.jsonl'))

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.title).toBe('Ante vault title')
    expect(result.sessions[0]?.totalTokens).toBe(10)
    // With no transcript to fold, `meta.json`'s last-active stamp is the only thing that can date
    // the row; real stores hold sessions whose transcript is absent after 66 turns.
    expect(result.sessions[0]?.createdAt).toBe('2026-05-01T10:11:00.000Z')
    expect(result.sessions[0]?.updatedAt).toBe('2026-05-01T10:11:02.000Z')
  })

  it('publishes turns past the old preview window and dates the row from the transcript tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ante-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const metadataFile = await writeAnteScannerFixture(roots.anteSessionsDir)
    // Ante emits several records per turn, so a long session outgrows a fixed line window.
    const toolRecords = Array.from({ length: 4100 }, (_, index) =>
      JSON.stringify({
        timestamp: '2026-05-01T11:00:00.000000Z',
        id: `evt_tool_${index}`,
        event: { ToolStart: { id: `call_${index}`, name: 'Bash', args: { command: 'ls' } } }
      })
    )
    await writeFile(
      join(roots.anteSessionsDir, 'ante-session', 'events.jsonl'),
      `${[
        JSON.stringify({
          timestamp: '2026-05-01T11:00:00.000000Z',
          id: 'evt_open',
          event: { UserInput: 'first question' }
        }),
        ...toolRecords,
        JSON.stringify({
          timestamp: '2026-05-01T12:30:00.000000Z',
          id: 'evt_last',
          event: { AgentMessage: 'late answer' }
        })
      ].join('\n')}\n`
    )

    const messages: TranscriptMessage[] = []
    const session = await parseAnteSessionFile(
      { path: metadataFile, mtimeMs: 1, modifiedAt: '2026-05-01T10:11:00.000Z' },
      'darwin',
      { active: true, push: (message) => messages.push(message) }
    )

    // Search indexes what the sink receives, so the last turn cannot depend on arriving early.
    expect(messages.map((message) => message.text)).toContain('late answer')
    expect(session?.updatedAt).toBe('2026-05-01T12:30:00.000Z')
    // The row itself still reports `meta.json`'s totals.
    expect(session?.messageCount).toBe(4)
  })
})
