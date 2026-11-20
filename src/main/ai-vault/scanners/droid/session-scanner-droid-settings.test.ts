import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'

let failSettingsReads = false
vi.mock(
  '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WslTranscriptFsAccess>()
    return {
      ...actual,
      wslGatedReadFile: (
        ...args: Parameters<typeof actual.wslGatedReadFile>
      ): ReturnType<typeof actual.wslGatedReadFile> => {
        if (failSettingsReads && String(args[0]).endsWith('.settings.json')) {
          return Promise.reject(new WslTranscriptFsError('timeout', 'wsl fs timed out'))
        }
        return actual.wslGatedReadFile(...args)
      }
    }
  }
)
import type * as WslTranscriptFsAccess from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { scanAiVaultSessions } from '../../session-scanner'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import {
  isolatedScanRoots,
  writeJsonlFile
} from '../../scanner-fixtures/session-scanner-test-fixtures'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let tempRoots: string[] = []

afterEach(async () => {
  failSettingsReads = false
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Mirror the records Droid persists (2026-11): no `system` or `completion` records.
async function writeDroidSession(): Promise<{
  scanOptions: ReturnType<typeof isolatedScanRoots>
  transcriptPath: string
  settingsPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-droid-settings-'))
  tempRoots.push(root)
  const scanOptions = isolatedScanRoots(root)
  const projectDir = join(scanOptions.droidSessionsDir, '-repo-app')
  const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`)
  await writeJsonlFile(transcriptPath, [
    {
      type: 'session_start',
      id: SESSION_ID,
      title: 'Droid task',
      cwd: '/repo/app',
      timestamp: '2026-11-01T10:00:00.000Z'
    },
    {
      type: 'message',
      role: 'user',
      text: 'fix the bug',
      timestamp: '2026-11-01T10:00:01.000Z'
    },
    { type: 'agent_turn_outcome', reason: 'completed', resultKind: 'text' }
  ])
  return {
    scanOptions,
    transcriptPath,
    settingsPath: join(projectDir, `${SESSION_ID}.settings.json`)
  }
}

async function writeSettings(
  settingsPath: string,
  settings: Record<string, unknown>
): Promise<void> {
  await writeFile(settingsPath, JSON.stringify(settings))
}

async function scanDroid(
  scanOptions: ReturnType<typeof isolatedScanRoots>
): Promise<AiVaultSession | undefined> {
  const result = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
  return result.sessions.find((session) => session.agent === 'droid')
}

describe('droid settings sidecar', () => {
  it('reads model and own token usage from the settings sidecar', async () => {
    const { scanOptions, settingsPath } = await writeDroidSession()
    await writeSettings(settingsPath, {
      model: 'claude-opus-5-5',
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
        // Thinking is already part of output tokens.
        thinkingTokens: 5,
        factoryCredits: 999
      },
      inclusiveTokenUsage: { inputTokens: 1_000_000 }
    })

    const session = await scanDroid(scanOptions)

    expect(session?.model).toBe('claude-opus-5-5')
    expect(session?.totalTokens).toBe(100)
  })

  it('refreshes tokens when the transcript changes after a turn', async () => {
    const { scanOptions, transcriptPath, settingsPath } = await writeDroidSession()
    await writeSettings(settingsPath, { model: 'm1', tokenUsage: { inputTokens: 1 } })
    await scanDroid(scanOptions)

    await writeSettings(settingsPath, {
      model: 'm1',
      tokenUsage: { inputTokens: 2, outputTokens: 3 }
    })
    await appendFile(
      transcriptPath,
      `${JSON.stringify({ type: 'message', role: 'assistant', text: 'done' })}\n`
    )
    const later = new Date((await stat(transcriptPath)).mtimeMs + 10_000)
    await utimes(transcriptPath, later, later)
    const session = await scanDroid(scanOptions)

    expect(session?.model).toBe('m1')
    expect(session?.totalTokens).toBe(5)
  })

  it('retries a refused settings read on the next scan', async () => {
    const { scanOptions, settingsPath } = await writeDroidSession()
    await writeSettings(settingsPath, { model: 'm1', tokenUsage: { inputTokens: 4 } })

    failSettingsReads = true
    const refused = await scanDroid(scanOptions)
    expect(refused?.sessionId).toBe(SESSION_ID)
    expect(refused?.model).toBeNull()

    failSettingsReads = false
    const healed = await scanDroid(scanOptions)
    expect(healed?.model).toBe('m1')
    expect(healed?.totalTokens).toBe(4)
  })
})
