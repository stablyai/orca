import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from './orca-runtime-tests/agent-transcript-pane-test-harness'
import type { RuntimeVisibleTerminalState } from './terminal/records/runtime-terminal-state-records'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

async function replayDialog(
  name: string,
  connectionId?: string,
  pane: Partial<Parameters<typeof createTranscriptPane>[0]> = {}
) {
  const base = join(__dirname, '__fixtures__', name)
  const size: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  const bytes = readFileSync(`${base}.txt`)
  const transcript = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    ...pane,
    connectionId,
    size,
    data: ''
  })
  const decoder = new TextDecoder()
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    transcript.runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      decoder.decode(bytes.subarray(offset, offset + 1024), { stream: true }),
      Date.now()
    )
  }
  return transcript
}

describe('Claude dialog screen observation fences', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000))
  afterEach(() => vi.restoreAllMocks())

  async function pendingScreen() {
    const pane = await replayDialog('claude-dialog-trust-workspace')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this runtime method is protected; the spy delays its real result without changing the screen.
    const reader = pane.runtime as unknown as {
      readVisibleTerminalState(ptyId: string): Promise<RuntimeVisibleTerminalState | null>
    }
    const screen = await reader.readVisibleTerminalState(TRANSCRIPT_PANE_PTY_ID)
    let resolve!: (value: RuntimeVisibleTerminalState | null) => void
    const pending = new Promise<RuntimeVisibleTerminalState | null>((done) => {
      resolve = done
    })
    vi.spyOn(reader, 'readVisibleTerminalState').mockReturnValue(pending)
    return { ...pane, release: () => resolve(screen) }
  }

  it('discards a dialog snapshot if newer output arrives during the read', async () => {
    const pane = await pendingScreen()
    const wait = pane.runtime.getTerminalInteractiveWait(pane.handle)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[2J\x1b[H', Date.now())
    pane.release()
    await expect(wait).resolves.toBeUndefined()
  })

  it('discards a dialog snapshot after the owning terminal exits', async () => {
    const pane = await pendingScreen()
    const wait = pane.runtime.getTerminalInteractiveWait(pane.handle)
    pane.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    pane.release()
    await expect(wait).resolves.toBeUndefined()
  })
})
