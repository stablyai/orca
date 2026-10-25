/** A crashed agent returns to a bracketed-paste shell prompt; real zsh/daemon foreground evidence must prevent delivery. */
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
// Use a function: the Windows registration scanner misclassifies platform-gated const ternaries.
function findZsh(): string {
  if (process.platform === 'win32') {
    return ''
  }
  return (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout ?? '').trim()
}

const ZSH_PATH = findZsh()
const describeWithZsh = ZSH_PATH ? describe : describe.skip

const STUBS = {
  crash: "#!/bin/sh\nprintf 'stub: crashing at startup\\r\\n'\nexit 1\n",
  ready: "#!/bin/sh\nprintf '\\033[?2004hstub agent\\r\\n> '\nexec sleep 30\n"
} as const

let home = ''
let savedLoginOptOut: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-crash-guard-'))
  savedLoginOptOut = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
  delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
})

afterEach(() => {
  if (savedLoginOptOut !== undefined) {
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = savedLoginOptOut
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function launchStub(stub: keyof typeof STUBS, readyTimeoutMs: number) {
  const bin = join(home, 'bin')
  mkdirSync(bin)
  // login resets HOME/PATH; absolute stubs prevent accidentally running a real agent.
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
      // Unknown foreground may settle readiness, but only proven agent foreground may admit the write.
      await launch.ready
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
