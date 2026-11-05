import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from './orca-runtime-tests/agent-transcript-pane-test-harness'
import type { RuntimeVisibleTerminalState } from './terminal/records/runtime-terminal-state-records'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import { makeTuiIdlePty } from './terminal/wait/tui-idle-wait-test-harness'

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

describe.each([undefined, 'ssh:build-host'])(
  'Claude interactive-wait query on %s',
  (connectionId) => {
    it.each([
      ['claude-dialog-trust-workspace', true],
      ['claude-dialog-trust-workspace-narrow', true],
      ['claude-dialog-trust-workspace-answered', false]
    ] as const)('reports the current dialog in %s', async (name, blocked) => {
      const { runtime, handle } = await replayDialog(name, connectionId)
      const wait = await runtime.getTerminalInteractiveWait(handle)
      if (blocked) {
        expect(wait).toMatchObject({ reason: 'agent-trust-workspace' })
      } else {
        expect(wait).toBeNull()
      }
    })
  }
)

describe('hand-typed native Claude, whose process name is its version', () => {
  afterEach(() => vi.useRealTimers())

  function typedPane(overrides: Partial<Parameters<typeof createTranscriptPane>[0]> = {}) {
    const counts = { probes: 0, scans: 0 }
    const pane = replayDialog('claude-dialog-trust-workspace', undefined, {
      paneTitle: 'bash',
      launchAgent: undefined,
      foregroundProcess: '2.1.310',
      confirmedForegroundProcess: 'claude',
      onForegroundProbe: () => counts.probes++,
      onForegroundScan: () => counts.scans++,
      ...overrides
    })
    return pane.then(async (created) => {
      // The dialog has been painted for a while when someone asks; let the emulator apply it.
      await created.runtime['readVisibleTerminalState'](TRANSCRIPT_PANE_PTY_ID)
      return { ...created, counts }
    })
  }

  it('reports its trust dialog without storing the scanned identity', async () => {
    const { runtime, handle, counts } = await typedPane()
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      reason: 'agent-trust-workspace'
    })
    const before = runtime['ptysById'].get(TRANSCRIPT_PANE_PTY_ID)?.foregroundAgent
    await runtime.refreshPtyForegroundAgentFromController(TRANSCRIPT_PANE_PTY_ID)
    expect(runtime['ptysById'].get(TRANSCRIPT_PANE_PTY_ID)?.foregroundAgent).toBe(before)
    expect(before).not.toBe('claude')
    expect(counts.scans).toBe(1)
  })

  // Windows native Claude is claude.exe, recognized by name; only POSIX scans a version name.
  it.skipIf(process.platform === 'win32')(
    'keeps native Claude identified once its own title is up',
    async () => {
      const { runtime } = await createTranscriptPane({
        paneTitle: 'bash',
        foregroundProcess: '2.1.310',
        confirmedForegroundProcess: 'claude',
        data: '\u001b]0;\u2733 Fix the build\u0007'
      })
      await runtime.refreshPtyForegroundAgentFromController(TRANSCRIPT_PANE_PTY_ID)
      expect(runtime['ptysById'].get(TRANSCRIPT_PANE_PTY_ID)?.foregroundAgent).toBe('claude')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'drops a confirming scan that a newer transition superseded',
    async () => {
      const pty = makeTuiIdlePty({
        lastAgentStatus: 'idle',
        launchAgent: null,
        foregroundAgent: null
      })
      let foreground = '2.1.310'
      let finishScan: ((name: string) => void) | undefined
      const controller = {
        getForegroundProcess: async () => foreground,
        confirmForegroundProcess: () =>
          new Promise<string>((resolve) => {
            finishScan = resolve
          })
      }
      const tracker = new RuntimePtyForegroundAgent({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker calls only these two controller methods.
        getController: () => controller as unknown as RuntimePtyController,
        getPty: () => pty,
        touchSnapshot: () => {},
        finishDelayedSnapshot: () => {}
      })
      const first = tracker.refresh(pty.ptyId, 1)
      await vi.waitFor(() => expect(finishScan).toBeDefined())
      foreground = 'bash'
      pty.lastAgentStatus = null
      const second = tracker.refresh(pty.ptyId, 2)
      finishScan?.('claude')
      await Promise.all([first, second])
      expect(pty.foregroundAgent).toBeNull()
    }
  )

  it('never scans for a name that is not a version', async () => {
    const { runtime, handle, counts } = await typedPane({ foregroundProcess: 'vim' })
    await runtime.getTerminalInteractiveWait(handle)
    expect(counts.scans).toBe(0)
  })

  it('answers unknown when the foreground read never returns', async () => {
    const { runtime, handle } = await typedPane({ foregroundProbeHangs: true })
    vi.useFakeTimers()
    const wait = runtime.getTerminalInteractiveWait(handle)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(wait).resolves.toBeUndefined()
  })

  it('does not read the foreground of a plain shell', async () => {
    const counts = { probes: 0 }
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'bash',
      foregroundProcess: 'bash',
      onForegroundProbe: () => counts.probes++,
      data: 'user@host repo $ '
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    expect(counts.probes).toBe(0)
  })
})

describe('Claude dialog screen observation fences', () => {
  afterEach(() => vi.useRealTimers())

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

  it('uses a fresh working title when output overtakes the screen read', async () => {
    const pane = await pendingScreen()
    const wait = pane.runtime.getTerminalInteractiveWait(pane.handle)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠂ Claude Code\x07', Date.now())
    pane.release()
    await expect(wait).resolves.toBeNull()
  })

  it('does not let an old dialog override a newer working lifecycle', async () => {
    const pane = await replayDialog('claude-dialog-trust-workspace')
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;⠂ Claude Code\x07', Date.now())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the existing protected lifecycle recorder; the test models current working evidence over unchanged old screen text.
    const lifecycle = pane.runtime as unknown as {
      recordAgentPromptLifecycleState(ptyId: string, status: 'working'): void
    }
    lifecycle.recordAgentPromptLifecycleState(TRANSCRIPT_PANE_PTY_ID, 'working')
    await expect(pane.runtime.getTerminalInteractiveWait(pane.handle)).resolves.toBeNull()
  })

  it('discards a dialog snapshot after the owning terminal exits', async () => {
    const pane = await pendingScreen()
    const wait = pane.runtime.getTerminalInteractiveWait(pane.handle)
    pane.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    pane.release()
    await expect(wait).resolves.toBeUndefined()
  })

  it('bounds a screen read that never answers', async () => {
    const pane = await pendingScreen()
    vi.useFakeTimers()
    const wait = pane.runtime.getTerminalInteractiveWait(pane.handle)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(wait).resolves.toBeUndefined()
    pane.release()
  })
})
