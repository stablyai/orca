import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import type { RuntimeVisibleTerminalState } from '../records/runtime-terminal-state-records'

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
  const base = join(__dirname, '..', '..', '__fixtures__', name)
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

it('retires an answered dialog for later turns and blocks a repeated live dialog', async () => {
  const pane = await replayDialog('claude-dialog-trust-workspace')
  await pane.runtime.getTerminalInteractiveWait(pane.handle)
  vi.useFakeTimers()
  try {
    const first = pane.runtime.waitForTerminal(pane.handle, { condition: 'tui-idle' })
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(first).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
    const ingest = (data: string) =>
      pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
    const expectWorking = async () => {
      const abort = new AbortController()
      const settled = vi.fn()
      const wait = pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: 60_000,
        signal: abort.signal
      })
      void wait.then(settled, () => {})
      await vi.advanceTimersByTimeAsync(4_000)
      expect(settled).not.toHaveBeenCalled()
      abort.abort()
      await wait.catch(() => {})
    }
    await vi.advanceTimersByTimeAsync(1)
    ingest('\x1b[2J\x1b[H\x1b]0;Claude working\x07\x1b]7501;state=working:app=claude-code\x07')
    await expectWorking()
    ingest('\x1b]0;Claude idle\x07\x1b]7501;state=idle:app=claude-code\x07')
    await vi.advanceTimersByTimeAsync(1)
    ingest('\x1b]0;Claude working\x07\x1b]7501;state=working:app=claude-code\x07')
    await expectWorking()
    ingest('\x1b]0;Claude idle\x07\x1b]7501;state=idle:app=claude-code\x07')
    const completed = pane.runtime.waitForTerminal(pane.handle, { condition: 'tui-idle' })
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(completed).resolves.toMatchObject({ satisfied: true })
    await vi.advanceTimersByTimeAsync(1)
    ingest(
      readFileSync(join(__dirname, '../../__fixtures__/claude-dialog-trust-workspace.txt'), 'utf8')
    )
    await expect(pane.runtime.getTerminalInteractiveWait(pane.handle)).resolves.toMatchObject({
      reason: 'agent-trust-workspace'
    })
    expect(
      (await pane.runtime.readTerminal(pane.handle, { screen: true })).tail.join('\n')
    ).toContain('trust this folder')
    const repeated = pane.runtime.waitForTerminal(pane.handle, { condition: 'tui-idle' })
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(repeated).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a current provider dialog blocked after a newer working transition', async () => {
  const base = join(__dirname, '../../__fixtures__/claude-dialog-trust-workspace')
  const data = readFileSync(`${base}.txt`, 'utf8')
  const size: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  let frame = data
  let providerSequence = 10_000
  const pane = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: '',
    serializeProviderBuffer: async () => ({
      data: frame,
      ...size,
      seq: providerSequence,
      source: 'headless',
      alternateScreen: false
    })
  })
  vi.useFakeTimers()
  try {
    pane.runtime.synchronizePtyOutputSequenceFromProvider(
      TRANSCRIPT_PANE_PTY_ID,
      { value: providerSequence, generation: 'continued' },
      pane.runtime.getPtyOutputSequence(TRANSCRIPT_PANE_PTY_ID)
    )
    pane.runtime.seedTerminalRestoreTail(TRANSCRIPT_PANE_PTY_ID, {
      text: data,
      lastTitle: 'Claude Code'
    })
    await pane.runtime.readTerminal(pane.handle, { screen: true })
    await vi.advanceTimersByTimeAsync(1)
    const working = '\x1b]0;Claude working\x07\x1b]7501;state=working:app=claude-code\x07'
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, working, Date.now())
    providerSequence += working.length
    await pane.runtime.readTerminal(pane.handle, { screen: true })
    await expect(pane.runtime.getTerminalInteractiveWait(pane.handle)).resolves.toMatchObject({
      reason: 'agent-trust-workspace'
    })
    await expect(
      pane.runtime.waitForTerminal(pane.handle, { condition: 'tui-idle', timeoutMs: 0 })
    ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-trust-workspace' })
    frame = readFileSync(
      join(__dirname, '../../__fixtures__/claude-dialog-trust-workspace-answered.txt'),
      'utf8'
    )
    const clear = '\x1b[2J\x1b[H'
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, clear, Date.now())
    providerSequence += clear.length
    await pane.runtime.readTerminal(pane.handle, { screen: true })
    await pane.runtime.getTerminalInteractiveWait(pane.handle)
    const abort = new AbortController()
    const settled = vi.fn()
    const pending = pane.runtime.waitForTerminal(pane.handle, {
      condition: 'tui-idle',
      signal: abort.signal
    })
    void pending.then(settled, () => {})
    await vi.advanceTimersByTimeAsync(4_000)
    expect(settled).not.toHaveBeenCalled()
    abort.abort()
    await pending.catch(() => {})
  } finally {
    vi.useRealTimers()
  }
})
