import '../daemon/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as ProcessTableSnapshotReader from '../../shared/process-table-snapshot-reader'
import type { SubprocessHandle } from '../daemon/session-subprocess-handle'
import { TerminalHost } from '../daemon/terminal-host'
import { proveDaemonShellForeground } from '../providers/shell-foreground-proof'
import { confirmPaneShellForegroundProcess } from '../providers/agent-foreground-process'
import {
  endCommand,
  expectEveryReaderSawTheClear,
  expectNoReaderLostTheRow,
  launchAgentPane,
  liveRow,
  postHook,
  wireCommandEndHost,
  type CommandEndHost,
  type CommandEndPath
} from './command-end-host-wiring.test-fixture'

// The terminal daemon, Orca's default local backend, answers its shell confirm from its byte
// scanner, which only proves a shell after a full-screen exit. A Codex run in the normal screen
// buffer that quits must still be verified, from the daemon's fenced process evidence.

const processTable = vi.hoisted(
  (): {
    rows: ProcessTableRow[]
    captures: { rows: ProcessTableRow[]; capturedAgeMs: number }[]
    reads: number
    freshReads: number
  } => ({
    rows: [],
    captures: [],
    reads: 0,
    freshReads: 0
  })
)
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshotReader>()),
  // A queued capture is served first, as the shared cache would. Otherwise a fresh capture, aged
  // as the host stamps it: from the start of a `ps` that takes time.
  getStrictProcessTableSnapshotWithAge: async () => {
    processTable.reads += 1
    const queued = processTable.captures.shift()
    if (queued) {
      return queued
    }
    const startedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { rows: processTable.rows, capturedAgeMs: Date.now() - startedAt }
  },
  // Main's own fresh read of this machine's process table.
  getFreshShellForegroundSnapshot: async () => {
    processTable.freshReads += 1
    return processTable.rows
  }
}))

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/retirement-clear',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const ROOT_PID = 99_999
const LOGIN_SHELL_PID = 99_990
const AGENT_PID = 100_100

/**
 * The pane's process table: its zsh alone in front, or a Codex process group in front of it. On
 * macOS the daemon spawns the shell under `/usr/bin/login` for TCC attribution, so the PTY's root
 * is login and the shell is its child in its own process group.
 */
function paneProcesses(
  front: 'shell' | 'codex',
  root: 'shell' | 'macos-login' = 'shell'
): ProcessTableRow[] {
  const tty = '/dev/pts/7'
  const shellPid = root === 'shell' ? ROOT_PID : LOGIN_SHELL_PID
  const foregroundPgid = front === 'shell' ? shellPid : AGENT_PID
  const login = {
    pid: ROOT_PID,
    ppid: 1,
    pgid: ROOT_PID,
    tpgid: foregroundPgid,
    tty,
    startTime: 'login-birth',
    stat: 'Ss',
    command: '/usr/bin/login -flpq qa /bin/bash --noprofile --norc -p -c exec'
  }
  const shell = {
    pid: shellPid,
    ppid: root === 'shell' ? 1 : ROOT_PID,
    pgid: shellPid,
    tpgid: foregroundPgid,
    tty,
    startTime: 'shell-birth',
    stat: front === 'shell' ? 'Ss+' : 'Ss',
    command: root === 'shell' ? '/bin/zsh' : '-zsh'
  }
  const codex = {
    pid: AGENT_PID,
    ppid: shellPid,
    pgid: AGENT_PID,
    tpgid: foregroundPgid,
    tty,
    startTime: 'codex-birth',
    stat: 'S+',
    command: 'node /opt/homebrew/bin/codex'
  }
  return [...(root === 'macos-login' ? [login] : []), shell, ...(front === 'codex' ? [codex] : [])]
}

function createSubprocess(): { handle: SubprocessHandle; emit: (data: string) => void } {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  const handle: SubprocessHandle = {
    pid: ROOT_PID,
    getForegroundProcess: vi.fn(() => 'zsh'),
    // The fresh process read exists, but the daemon only asks it after a full-screen exit.
    confirmShellForeground: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn()
  }
  return { handle, emit: (data) => onData?.(data) }
}

type DaemonPane = {
  host: CommandEndHost
  pane: { ptyId: string; paneKey: string; launchToken: string }
  emit: (data: string) => void
}

const teardowns: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) {
    await teardown()
  }
  processTable.rows = []
  processTable.captures = []
  processTable.reads = 0
  processTable.freshReads = 0
  vi.restoreAllMocks()
})

/** An Orca-launched Codex pane whose PTY is a real daemon session. */
async function launchDaemonCodexPane(
  ptyId: string,
  platform: NodeJS.Platform = 'linux'
): Promise<DaemonPane> {
  const subprocess = createSubprocess()
  const terminalHost = new TerminalHost({ spawnSubprocess: () => subprocess.handle })
  teardowns.push(() => terminalHost.dispose())
  const session = await terminalHost.createOrAttach({
    sessionId: ptyId,
    cols: 80,
    rows: 24,
    streamClient: { onData: vi.fn(), onExit: vi.fn() }
  })
  const host = await wireCommandEndHost({
    controller: {
      // The daemon adapter's proof, over a real daemon session instead of its socket.
      proveShellForeground: (id, options) =>
        proveDaemonShellForeground({
          ptyId: id,
          incarnationId: options?.expectedIncarnationId ?? null,
          platform,
          confirmShellForeground: () => terminalHost.confirmShellForeground(id),
          inspectProcess: () =>
            terminalHost.inspectProcess(
              id,
              options?.expectedIncarnationId
                ? { expectedIncarnationId: options.expectedIncarnationId }
                : undefined
            ),
          confirmPaneShellForeground: confirmPaneShellForegroundProcess
        })
    }
  })
  teardowns.push(host.teardown)
  const pane = await launchAgentPane(host, ptyId, 'codex', session.incarnationId)
  await postHook(host.server, 'codex', pane, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'codex-session',
    prompt: 'review the PR'
  })
  await postHook(host.server, 'codex', pane, {
    hook_event_name: 'Stop',
    session_id: 'codex-session'
  })
  expect(liveRow(host.server, pane.paneKey)?.state).toBe('done')
  host.readers.republishedWorktrees.length = 0
  return { host, pane, emit: subprocess.emit }
}

/** Waits for main's own process-table read, which decides the verdict, then lets it land. */
async function settledOnTheFirstAsk(): Promise<void> {
  await vi.waitFor(() => expect(processTable.freshReads).toBe(1), { timeout: 2_000, interval: 20 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(processTable.reads).toBe(1)
}

/** The same bytes reach the daemon's scanner and main's command-end path. */
async function runCommandToItsEnd(daemonPane: DaemonPane, path: CommandEndPath): Promise<void> {
  // Codex renders inline in the normal screen buffer: no alternate-screen episode.
  daemonPane.emit('\x1b]133;C\x07codex output\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ')
  await endCommand(daemonPane.host.runtime, daemonPane.pane.ptyId, path)
}

describe('a normal-buffer agent on a terminal-daemon pane', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`quits to the shell: the row clears for every reader (${path})`, async () => {
      const daemonPane = await launchDaemonCodexPane(`pty-daemon-exit-${path.replace(' ', '-')}`)
      processTable.rows = paneProcesses('shell')

      await runCommandToItsEnd(daemonPane, path)

      // On the first ask: well before the re-ask would run.
      await vi.waitFor(
        () =>
          expectEveryReaderSawTheClear(
            daemonPane.host.server,
            daemonPane.host.readers,
            daemonPane.pane.paneKey
          ),
        { timeout: 2_000, interval: 20 }
      )
      expect(processTable.reads).toBe(1)
    })

    it(`still in front after a nested shell's marker: the row stays (${path})`, async () => {
      const daemonPane = await launchDaemonCodexPane(`pty-daemon-live-${path.replace(' ', '-')}`)
      processTable.rows = paneProcesses('codex')

      await runCommandToItsEnd(daemonPane, path)
      await settledOnTheFirstAsk()

      expectNoReaderLostTheRow(
        daemonPane.host.server,
        daemonPane.host.readers,
        daemonPane.pane.paneKey,
        'done'
      )
    })
  }

  it('on Windows, where the daemon has no foreground evidence, takes the command end as the exit', async () => {
    const daemonPane = await launchDaemonCodexPane('pty-daemon-windows', 'win32')
    processTable.rows = paneProcesses('codex')

    await runCommandToItsEnd(daemonPane, 'daemon fact')

    expectEveryReaderSawTheClear(
      daemonPane.host.server,
      daemonPane.host.readers,
      daemonPane.pane.paneKey
    )
  })

  it('is not held by a shared capture from before the exit: a fresh read here decides', async () => {
    const daemonPane = await launchDaemonCodexPane('pty-daemon-stale-capture')
    // A poll's capture from just before the exit, served from the cache 300 ms later.
    processTable.captures = [{ rows: paneProcesses('codex'), capturedAgeMs: 300 }]
    processTable.rows = paneProcesses('shell')

    await runCommandToItsEnd(daemonPane, 'daemon fact')

    await vi.waitFor(
      () =>
        expectEveryReaderSawTheClear(
          daemonPane.host.server,
          daemonPane.host.readers,
          daemonPane.pane.paneKey
        ),
      { timeout: 2_000, interval: 20 }
    )
  })

  // QA G4 (macOS, default daemon backend): a parked pane's Gemini quit, zsh was in front, and Done
  // stayed on every surface, also after a later command end.
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`on macOS, under the login wrapper, quits to the shell: the row clears (${path})`, async () => {
      const daemonPane = await launchDaemonCodexPane(`pty-daemon-login-${path.replace(' ', '-')}`)
      processTable.rows = paneProcesses('shell', 'macos-login')

      await runCommandToItsEnd(daemonPane, path)

      await vi.waitFor(
        () =>
          expectEveryReaderSawTheClear(
            daemonPane.host.server,
            daemonPane.host.readers,
            daemonPane.pane.paneKey
          ),
        { timeout: 2_000, interval: 20 }
      )
    })
  }

  it('on macOS, under the login wrapper, an agent still in front keeps its row', async () => {
    const daemonPane = await launchDaemonCodexPane('pty-daemon-login-live')
    processTable.rows = paneProcesses('codex', 'macos-login')

    await runCommandToItsEnd(daemonPane, 'daemon fact')
    await settledOnTheFirstAsk()

    expectNoReaderLostTheRow(
      daemonPane.host.server,
      daemonPane.host.readers,
      daemonPane.pane.paneKey,
      'done'
    )
  })
})
