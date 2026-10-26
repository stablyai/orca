/** Trust dialogs also enable bracketed paste and settle quiet rendering; screen evidence must veto prompt delivery. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import {
  waitForLaunchedAgentComposer,
  waitForWorkerStartComposer
} from './launched-agent-composer-readiness'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as TerminalForegroundGroup from './terminal-foreground-group'

const paneTerminal = vi.hoisted(() => {
  const state: { rows: ProcessTableRow[] | null } = { rows: null }
  return state
})
vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: vi.fn(async () => paneTerminal.rows)
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const QUIET_WINDOW_MS = 1_500

function readCapture(name: string): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', name)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

async function launchAndStream(
  name: string,
  timeoutMs: number,
  pane: Partial<Parameters<typeof createTranscriptPane>[0]> = {}
) {
  const { data, size } = readCapture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: '',
    ...pane
  })
  // Pane creation awaits real timers; the wait and its quiet window use the virtual clock.
  vi.useFakeTimers()
  const ready = waitForLaunchedAgentComposer(runtime, handle, 'claude', timeoutMs)
  const settled = vi.fn()
  ready.then(settled, settled)
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  return { ready, settled }
}

describe('launch readiness for a freshly launched Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('claude-dialog-trust-workspace-answered: reads the composer after the answered dialog as ready', async () => {
    const { data } = readCapture('claude-dialog-trust-workspace-answered')
    expect(data).toContain('\x1b[?2004h')
    const { ready, settled } = await launchAndStream(
      'claude-dialog-trust-workspace-answered',
      60_000
    )

    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS + 100)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({ satisfied: true })
  })

  it('claude-dialog-trust-workspace-answered: over SSH, settles on the quiet window, not the 8 s fallback', async () => {
    const { ready, settled } = await launchAndStream(
      'claude-dialog-trust-workspace-answered',
      60_000,
      // Relay lacks scan/shell proof; fabricating either would refuse readiness.
      { connectionId: 'ssh-1', confirmedForegroundProcess: 'zsh', shellForegroundProven: true }
    )

    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS + 300)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({ satisfied: true })
  })

  it('claude-dialog-trust-workspace: never reads the trust dialog as the composer', async () => {
    const { ready, settled } = await launchAndStream('claude-dialog-trust-workspace', 60_000)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })
})

describe('a fresh orchestration worker start for Claude', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles on Claude’s ready title, before the launch paste’s quiet window', async () => {
    const { data, size } = readCapture('claude-dialog-trust-workspace-answered')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess: 'claude',
      launchAgent: 'claude',
      size,
      data: ''
    })
    vi.useFakeTimers()
    const ready = waitForWorkerStartComposer(runtime, handle, 'claude', 60_000)
    const settled = vi.fn()
    ready.then(settled, settled)
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())

    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS / 2)
    expect(settled).toHaveBeenCalled()
    await expect(ready).resolves.toMatchObject({ satisfied: true })
  })
})

describe('what holds a launched agent’s terminal', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { configurable: true, value })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  describe('macOS and Linux: the pane terminal’s own foreground group decides', () => {
    beforeEach(() => {
      setPlatform('darwin')
      paneTerminal.rows = null
    })

    // Captured macOS login shape: zsh owns the foreground group independently of the login root.
    const login = (tpgid: number): ProcessTableRow => ({
      pid: 60404,
      ppid: 60394,
      pgid: 60404,
      tpgid,
      stat: 'Ss',
      command: '/usr/bin/login -flpq user /bin/bash --noprofile --norc -p -c'
    })
    const zshAt = (tpgid: number): ProcessTableRow => ({
      pid: 60406,
      ppid: 60404,
      pgid: 60406,
      tpgid,
      stat: tpgid === 60406 ? 'S+' : 'S',
      command: '-/bin/zsh -f'
    })

    it.each([
      ['zsh back at its prompt', [login(60406), zshAt(60406)], 'shell'],
      [
        'claude in front',
        [
          login(60500),
          zshAt(60500),
          { pid: 60500, ppid: 60406, pgid: 60500, tpgid: 60500, stat: 'S+', command: 'claude' }
        ],
        'agent'
      ]
    ] as const)(
      '%s: answers from the rows, never the cached name or a whole-machine scan',
      async (_label, rows, found) => {
        paneTerminal.rows = [...rows]
        const scan = vi.fn()
        const inspection = vi.fn()
        const { runtime } = await createTranscriptPane({
          paneTitle: 'Claude Code',
          foregroundProcess: 'python3',
          confirmedForegroundProcess: 'claude',
          onForegroundScan: scan,
          processInspection: { foregroundProcess: 'claude', hasChildProcesses: true },
          onProcessInspection: inspection,
          paneRootPid: 60404,
          launchAgent: 'claude',
          data: ''
        })

        await expect(
          runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
        ).resolves.toBe(found)
        expect(scan).not.toHaveBeenCalled()
        expect(inspection).not.toHaveBeenCalled()
      }
    )

    it.each([
      ['without the pane’s root process', undefined, [login(60406), zshAt(60406)]],
      ['when ps cannot read the pane’s terminal', 60404, null]
    ] as const)('proves nothing %s', async (_label, paneRootPid, rows) => {
      paneTerminal.rows = rows ? [...rows] : null
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: 'claude',
        ...(paneRootPid ? { paneRootPid } : {}),
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe('unknown')
    })
  })

  // tcsh/nu wrappers lead with /bin/sh while the agent shares that foreground group.
  describe('SSH: the relay’s process-group observation, then its name', () => {
    beforeEach(() => setPlatform('darwin'))

    const shLeadsClaude = (capturedAgeMs: number, agentCommand: string) => {
      const row = (pid: number, ppid: number, stat: string, command: string): ProcessTableRow => ({
        pid,
        ppid,
        pgid: 40210,
        tpgid: 40210,
        stat,
        tty: 'pts/7',
        startTime: '1790950000',
        command
      })
      return {
        foregroundProcess: 'sh',
        hasChildProcesses: true,
        foregroundProcessEvidence: resolveRemoteForegroundEvidence(
          { rootPid: 40100, fallbackProcess: 'sh' },
          {
            ptyId: TRANSCRIPT_PANE_PTY_ID,
            ptyIncarnationId: 'inc-1',
            authorityGeneration: 'gen-1',
            observationEpoch: 1,
            capturedAgeMs,
            platform: 'linux'
          },
          [
            { ...row(40100, 40090, 'Ss', '-tcsh'), pgid: 40100 },
            row(40210, 40100, 'S+', '/bin/sh /tmp/orca-launch/run.sh'),
            row(40211, 40210, 'S+', agentCommand)
          ]
        )
      }
    }

    it.each([
      [
        'finds the launched agent behind the sh that leads its group',
        0,
        '/opt/bin/claude',
        'agent'
      ],
      [
        'takes the relay’s name over an observation too old to trust',
        1_500,
        '/opt/bin/claude',
        'shell'
      ],
      ['takes the relay’s name when the group holds another agent', 0, '/opt/bin/codex', 'shell']
    ] as const)('%s', async (_label, capturedAgeMs, agentCommand, found) => {
      const inspection = shLeadsClaude(capturedAgeMs, agentCommand)
      expect(inspection.foregroundProcessEvidence).toMatchObject({
        verdict: 'live',
        processName: expect.any(String)
      })
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'sh',
        processInspection: inspection,
        connectionId: 'ssh-1',
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe(found)
    })
  })

  // Windows scans may name shell/node.exe and shared jobs; only shell-foreground proof is authoritative.
  describe('Windows: only the shell-foreground check, and never the agent', () => {
    beforeEach(() => setPlatform('win32'))

    it.each([
      ['powershell.exe', false, 'unknown'],
      ['powershell.exe', true, 'shell'],
      ['claude', true, 'shell'],
      ['claude', false, 'unknown'],
      ['node', false, 'unknown']
    ] as const)('cached %s, shell check %s: %s', async (foregroundProcess, proven, found) => {
      const scan = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess,
        confirmedForegroundProcess: 'claude',
        onForegroundScan: scan,
        shellForegroundProven: proven,
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe(found)
      expect(scan).not.toHaveBeenCalled()
    })
  })

  // Contradictory stubs make any forbidden scan change the verdict.
  it.each([
    ['claude', 'agent'],
    ['bash', 'shell']
  ] as const)(
    'SSH: takes the relay’s own read %s (%s), without a scan or check',
    async (relayRead, found) => {
      setPlatform('darwin')
      const scan = vi.fn()
      const proof = vi.fn()
      const { runtime } = await createTranscriptPane({
        paneTitle: 'Claude Code',
        foregroundProcess: relayRead,
        confirmedForegroundProcess: found === 'shell' ? 'claude' : 'zsh',
        onForegroundScan: scan,
        shellForegroundProven: found !== 'shell',
        onShellForegroundProof: proof,
        connectionId: 'ssh-1',
        launchAgent: 'claude',
        data: ''
      })

      await expect(
        runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'claude')
      ).resolves.toBe(found)
      expect(scan).not.toHaveBeenCalled()
      expect(proof).not.toHaveBeenCalled()
    }
  )

  it('SSH to a Windows host: never the agent', async () => {
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Copilot',
      foregroundProcess: 'node',
      connectionId: 'ssh-1',
      remoteWindowsHost: true,
      launchAgent: 'copilot',
      data: ''
    })

    await expect(
      runtime.readLaunchedAgentForeground(TRANSCRIPT_PANE_PTY_ID, 'copilot')
    ).resolves.toBe('unknown')
  })
})
