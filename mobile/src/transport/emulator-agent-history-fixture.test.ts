import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMULATOR_AGENT_HISTORY_PREVIEW_MARKER,
  EMULATOR_AGENT_HISTORY_SEARCH_MARKER,
  EMULATOR_AGENT_HISTORY_TITLE,
  seedEmulatorAgentHistoryFixture
} from '../../scripts/emulator-agent-history-fixture.mjs'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = null
  }
})

describe('emulator Agent History fixture', () => {
  it('writes a bounded Codex transcript scoped to the requested workspace', async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'orca-agent-history-fixture-'))
    const transcriptPath = seedEmulatorAgentHistoryFixture({
      homeDir: temporaryDirectory,
      workspacePath: '/workspace/mobile-rearch'
    })
    const records = (await readFile(transcriptPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(transcriptPath).toContain(path.join('.codex', 'sessions', '2026', '07', '26'))
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({
      type: 'session_meta',
      payload: {
        cwd: '/workspace/mobile-rearch',
        title: EMULATOR_AGENT_HISTORY_TITLE,
        thread_source: 'user'
      }
    })
    expect(JSON.stringify(records)).toContain(EMULATOR_AGENT_HISTORY_SEARCH_MARKER)
    expect(JSON.stringify(records)).toContain(EMULATOR_AGENT_HISTORY_PREVIEW_MARKER)
  })
})
