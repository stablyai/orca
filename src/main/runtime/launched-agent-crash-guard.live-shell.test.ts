/**
 * A launched agent that exits at startup hands the terminal back to its shell, which turns bracketed
 * paste on at its next prompt just as an agent's composer does. Real zsh with a slow user config,
 * spawned the way a pane is (under `login` on macOS), read through the terminal daemon's own
 * foreground tracker: the launch must find the shell and write nothing, and must still find a live
 * agent.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { getStrictProcessTableSnapshotWithAge } from '../../shared/process-table-snapshot-reader'
import { createPtyForegroundProcessTracker } from '../daemon/pty-subprocess/foreground-process-tracker'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process'
import {
  prepareMacosTccLoginShell,
  wrapShellSpawnForMacosTccAttribution
} from '../providers/macos-tcc-login-shell'
import { readLaunchedAgentForeground } from './launched-agent-foreground'
import { createLaunchedAgentWriteGuard } from './launched-agent-write-guard'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

const PTY_ID = 'pty-1'
// A function, not a ternary: the Windows-lane registration scan reads a const assigned from a
// platform check as a Windows-only gate, and this suite runs everywhere but Windows.
function findZsh(): string {
  if (process.platform === 'win32') {
    return ''
  }
  return (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout ?? '').trim()
}

const ZSH_PATH = findZsh()
const describeWithZsh = ZSH_PATH ? describe : describe.skip

const STUBS = {
  // Exits at startup, as an agent with a bad config or a missing dependency does.
  crash: "#!/bin/sh\nprintf 'stub: crashing at startup\\r\\n'\nexit 1\n",
  // Opens its composer the way an agent does, then stays up.
  ready: "#!/bin/sh\nprintf '\\033[?2004hstub agent\\r\\n> '\nexec sleep 30\n"
} as const

let home = ''
let savedLoginOptOut: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-crash-guard-'))
  // The production spawn: a pane on macOS runs under `login` unless the user opted out.
  savedLoginOptOut = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
  delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
})

afterEach(() => {
  if (savedLoginOptOut !== undefined) {
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = savedLoginOptOut
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Launches the `claude` stub in a fresh zsh pane and runs the launch's own readiness wait. */
async function launchStub(stub: keyof typeof STUBS, readyTimeoutMs: number) {
  const bin = join(home, 'bin')
  mkdirSync(bin)
  // Typed by absolute path: `login` resets HOME and PATH, so a bare name would find a real agent.
  const stubPath = join(bin, 'claude')
  writeFileSync(stubPath, STUBS[stub])
  chmodSync(stubPath, 0o755)
  writeFileSync(join(home, '.zshrc'), 'sleep 2\n')
  const env = { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home, TERM: 'xterm-256color' }
  await prepareMacosTccLoginShell()
  const spawn = wrapShellSpawnForMacosTccAttribution(ZSH_PATH, ['-i'], env)
  const proc = pty.spawn(spawn.file, spawn.args, { cols: 80, rows: 24, cwd: home, env })
  let dead = false
  proc.onExit(() => {
    dead = true
  })
  const listeners = new Set<(data: string) => void>()
  let output = ''
  const tracker = createPtyForegroundProcessTracker({
    process: proc,
    shellPath: ZSH_PATH,
    cwd: home,
    sessionId: 'wt-crash-guard@@pane',
    startupAgentRecognition: recognizeAgentProcess('claude'),
    isDead: () => dead
  })
  proc.onData((data) => {
    tracker.recordOutput(data)
    output += data
    for (const listener of listeners) {
      listener(data)
    }
  })
  // The daemon's answers, each from the same pieces the daemon uses.
  const controller = {
    getForegroundProcess: async () => tracker.getForegroundProcess(),
    confirmForegroundProcess: () => tracker.confirmForegroundProcess(),
    confirmShellForeground: () => tracker.confirmShellForeground(),
    listProcesses: async () => [{ id: PTY_ID, rootProcessId: proc.pid, cwd: home, title: 'zsh' }],
    inspectProcess: async () => {
      const snapshot = await getStrictProcessTableSnapshotWithAge()
      return {
        foregroundProcess: tracker.getForegroundProcess(),
        hasChildProcesses: true,
        foregroundProcessEvidence: resolveRemoteForegroundEvidence(
          { rootPid: proc.pid, fallbackProcess: tracker.getForegroundProcess() },
          {
            ptyId: PTY_ID,
            ptyIncarnationId: 'inc-1',
            authorityGeneration: 'gen-1',
            observationEpoch: 1,
            capturedAgeMs: snapshot.capturedAgeMs,
            platform: process.platform
          },
          snapshot.rows
        )
      }
    }
  }
  const readForeground = (ptyId: string) =>
    readLaunchedAgentForeground(controller, { remote: false, windows: false }, ptyId, 'claude')
  const subscribe = (_ptyId: string, listener: (data: string) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const ready = waitForWorktreeStartupDraft(
    {
      getPtyId: () => PTY_ID,
      getForegroundProcess: controller.getForegroundProcess,
      subscribeToData: subscribe,
      readRecentOutput: () => undefined,
      write: () => {}
    },
    'term-1',
    'claude',
    {
      timeoutMs: readyTimeoutMs,
      isShellInFront: async (ptyId) => (await readForeground(ptyId)) === 'shell'
    }
  )
  proc.write(`'${stubPath}'\r`)
  const guard = createLaunchedAgentWriteGuard(
    { readLaunchedAgentForeground: readForeground, subscribeToTerminalData: subscribe },
    'claude'
  )
  const close = async (): Promise<void> => {
    guard.dispose()
    proc.kill()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { ready, guard, close, output: () => output }
}

describeWithZsh('a launch prompt after the launched agent exits at startup', () => {
  it('refuses the write after the shell’s prompt turns bracketed paste on', async () => {
    const launch = await launchStub('crash', 9_000)
    try {
      // The shell's prompt after the crash turned bracketed paste on and went quiet. A read that
      // finds the shell drops that signal; one that cannot answer on a loaded host lets it settle.
      // Either way only a read that finds the agent may let the text through.
      await launch.ready
      // Presence precondition: the stub, not anything else on the host, is what ran and exited.
      expect(launch.output()).toContain('stub: crashing at startup')
      await expect(launch.guard.beforeWrite(PTY_ID)).rejects.toThrow('agent_not_in_foreground')
    } finally {
      await launch.close()
    }
  }, 30_000)

  it('still finds an agent that stays up, and lets the write through', async () => {
    const launch = await launchStub('ready', 15_000)
    try {
      await expect(launch.ready).resolves.toBe(PTY_ID)
      expect(launch.output()).toContain('stub agent')
      await expect(launch.guard.beforeWrite(PTY_ID)).resolves.toBeUndefined()
    } finally {
      await launch.close()
    }
  }, 30_000)
})
