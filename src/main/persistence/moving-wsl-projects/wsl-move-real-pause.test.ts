/**
 * The quiesce step against real terminals: real shells on node-pty, hosted by a real in-process
 * daemon. Sleep ends them through the daemon, the daemon's own census proves they exited, its
 * final checkpoint names each pane's folder, and a new shell started there prints it.
 *
 * On Windows it runs only in the real-WSL lane (ORCA_WSL_MOVE_REAL_PAUSE_DISTRO): the shells are
 * `wsl.exe` in that distro, opened through its UNC path, exactly as a moving project's are.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import { DaemonServer } from '../../daemon/daemon-server'
import { getDaemonSocketPath } from '../../daemon/daemon-spawner'
import { HistoryReader } from '../../daemon/history-reader'
import { createPtySubprocess } from '../../daemon/pty-subprocess'
import { runProcessSync } from '@orca/process-host'
import { buildWslExecArgs } from '../../../shared/wsl-login-shell-command'
import { toWindowsWslUncPath } from '../../../shared/wsl-paths'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import {
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import { proveWslMoveTerminalsExited } from './wsl-move-exit-proof'
import { quiesceWslMove, type WslMoveQuiesceScope } from './wsl-move-quiesce'
import { captureWslMoveRestoreHints } from './wsl-move-restore-hints'

const WSL_DISTRO =
  process.platform === 'win32' ? process.env.ORCA_WSL_MOVE_REAL_PAUSE_DISTRO : undefined
const DISTRO = WSL_DISTRO ?? 'Ubuntu'
const SHELL = ['/bin/bash', '/bin/sh'].find(existsSync) ?? '/bin/sh'
const WORKTREE = `repo-1::${toWindowsWslUncPath('/home/dev/repo-1', DISTRO)}`
const PANE_A = 'tab-1:11111111-1111-4111-8111-111111111111'
const PANE_B = 'tab-2:22222222-2222-4222-8222-222222222222'
const SESSION_A = `${WORKTREE}@@aaaa1111`
const SESSION_B = `${WORKTREE}@@bbbb2222`
const TIMEOUT_MS = 20_000

type Daemon = {
  server: DaemonServer
  /** This app's client: the PTYs it holds are what `livePtyIds` reports. */
  adapter: DaemonPtyAdapter
  /** Another client of the same daemon, e.g. a window this process never adopted. */
  otherAdapter: DaemonPtyAdapter
}

let root: string
let home: string
let project: string
let userDataPath: string
let historyDir: string
let daemon: Daemon
let started: Daemon | undefined
const daemonDirs: string[] = []
const output = new Map<string, string>()
const exited = new Set<string>()
const heldByThisApp = new Set<string>()
const spawned: { adapter: DaemonPtyAdapter; id: string }[] = []

async function startDaemon(): Promise<Daemon> {
  // Its own short dir keeps the socket path inside sun_path, so the endpoint never relocates to /tmp.
  const daemonDir = mkdtempSync(join(tmpdir(), 'wmrp-'))
  daemonDirs.push(daemonDir)
  const socketPath = getDaemonSocketPath(daemonDir)
  const tokenPath = join(daemonDir, 'test.token')
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    spawnSubprocess: (opts) => createPtySubprocess(opts)
  })
  await server.start()
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
  const otherAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
  for (const client of [adapter, otherAdapter]) {
    client.onData(({ id, data }) => output.set(id, `${output.get(id) ?? ''}${data}`))
    client.onExit(({ id }) => exited.add(id))
  }
  return { server, adapter, otherAdapter }
}

/** `cwd` is the shell's own (Linux) folder; a WSL shell is opened through its UNC path. */
async function openShell(adapter: DaemonPtyAdapter, sessionId: string, cwd: string) {
  await adapter.spawn({
    cols: 120,
    rows: 30,
    sessionId,
    worktreeId: WORKTREE,
    ...(WSL_DISTRO
      ? { cwd: toWindowsWslUncPath(cwd, WSL_DISTRO), terminalWindowsWslDistro: WSL_DISTRO }
      : {
          cwd,
          shellOverride: SHELL,
          env: { HOME: home, SHELL, TERM: 'xterm-256color' }
        })
  })
  spawned.push({ adapter, id: sessionId })
  if (adapter === daemon.adapter) {
    heldByThisApp.add(sessionId)
  }
}

/** Types a command and waits for a marker the shell computes, so the echoed input never matches. */
async function run(adapter: DaemonPtyAdapter, sessionId: string, command: string, tag: string) {
  adapter.write(sessionId, `${command}; echo ${tag}_$((40+2))\n`)
  await vi.waitFor(() => expect(output.get(sessionId) ?? '').toContain(`${tag}_42`), {
    timeout: 10_000,
    interval: 25
  })
}

// What a shell with cwd reporting prints after `cd`; the daemon's checkpoint tracks OSC 7.
const reportCwd = 'printf \'\\033]7;file://localhost%s\\033\\\\\' "$PWD"'

/** Worktree Sleep's stopAndWait: end the PTY through the daemon, keep its history, await exit. */
async function sleepPane(sessionId: string): Promise<void> {
  await daemon.adapter.shutdown(sessionId, { keepHistory: true })
  await vi.waitFor(() => expect(exited.has(sessionId)).toBe(true), {
    timeout: 10_000,
    interval: 25
  })
  heldByThisApp.delete(sessionId)
}

function quiesceDeps(sleep: () => Promise<void>) {
  return {
    gateInputs: async () => ({ panes: [], runningAutomationRunIds: [], activeDispatchIds: [] }),
    sleepWorkspaces: async () => {
      await sleep()
      return { failedWorktreeIds: [] }
    },
    livePtyIds: () => [...heldByThisApp],
    captureRestoreHints: (panes: WslMoveQuiesceScope['panes'], distro: string) =>
      captureWslMoveRestoreHints(new HistoryReader(historyDir), panes, distro),
    proveExited: (proofScope: Parameters<typeof proveWslMoveTerminalsExited>[1]) =>
      proveWslMoveTerminalsExited(
        {
          listSessions: () => daemon.adapter.listSessions(),
          countFallbackSessions: () => 0,
          isScopeFenced: () => true
        },
        proofScope
      ),
    writeCutover: (cutover: Parameters<typeof writeWslMoveCutover>[1]) =>
      writeWslMoveCutover(userDataPath, cutover),
    removeCutover: (migrationId: string) => removeWslMoveCutover(userDataPath, migrationId),
    now: () => new Date('2026-10-20T00:00:00.000Z')
  }
}

function moveScope(): WslMoveQuiesceScope {
  return {
    workspaceIds: [WORKTREE],
    workspaceKeys: new Set([WORKTREE]),
    panes: [
      { paneKey: PANE_A, sessionId: SESSION_A, wslDistro: DISTRO },
      { paneKey: PANE_B, sessionId: SESSION_B, wslDistro: DISTRO }
    ]
  }
}

function prepareMove() {
  const prepared = wslMoveCutoverFixture('move-1', 'prepared', {}, {}, undefined, DISTRO)
  writeWslMoveCutover(userDataPath, prepared)
  return prepared
}

/** A project folder inside the distro, made there, so no Windows path stands in for it. */
function makeDistroProject(distro: string): string {
  const dir = `/tmp/orca-wmrp-${process.pid}-${Date.now()}`
  const made = runProcessSync({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['mkdir', '-p', `${dir}/sub`])
  })
  if (made.code !== 0) {
    throw new Error(`could not create ${dir} in ${distro}: ${made.stderr}`)
  }
  return dir
}

describe.skipIf(process.platform === 'win32' && !WSL_DISTRO)(
  'WSL move quiesce on real terminals',
  () => {
    beforeEach(async () => {
      // Real path: macOS tmp is a symlink through /private, and `pwd` prints the resolved one.
      root = realpathSync(mkdtempSync(join(tmpdir(), 'wsl-move-real-pause-')))
      home = join(root, 'home')
      project = WSL_DISTRO ? makeDistroProject(WSL_DISTRO) : join(root, 'project')
      userDataPath = join(root, 'user-data')
      historyDir = join(root, 'history')
      for (const dir of [home, ...(WSL_DISTRO ? [] : [join(project, 'sub')]), userDataPath]) {
        mkdirSync(dir, { recursive: true })
      }
      // A quiet prompt and no user rc files, so the user's own shell setup cannot leak in.
      for (const rc of ['.bash_profile', '.bashrc', '.profile']) {
        writeFileSync(join(home, rc), "PS1='prompt> '\n")
      }
      vi.stubEnv('HOME', home)
      vi.stubEnv('ENV', join(home, '.profile'))
      daemon = await startDaemon()
      started = daemon
    })

    afterEach(async () => {
      for (const { adapter, id } of spawned.splice(0)) {
        await adapter.shutdown(id, { immediate: true }).catch(() => {})
      }
      heldByThisApp.clear()
      output.clear()
      exited.clear()
      started?.adapter.dispose()
      started?.otherAdapter.dispose()
      await started?.server.shutdown()
      started = undefined
      vi.unstubAllEnvs()
      if (WSL_DISTRO) {
        runProcessSync({
          program: 'wsl.exe',
          args: buildWslExecArgs(WSL_DISTRO, ['rm', '-rf', project])
        })
      }
      for (const dir of [root, ...daemonDirs.splice(0)]) {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it(
      'pauses two real shells, proves they exited, journals the folder, and reopens a shell there',
      async () => {
        const sub = `${project}/sub`
        await openShell(daemon.adapter, SESSION_A, project)
        await openShell(daemon.adapter, SESSION_B, project)
        await run(daemon.adapter, SESSION_A, `cd sub && ${reportCwd}`, 'CD')
        await run(daemon.adapter, SESSION_B, reportCwd, 'AT')
        const census = await daemon.adapter.listSessions()
        expect(census.filter((s) => s.isAlive).map((s) => s.sessionId)).toEqual(
          expect.arrayContaining([SESSION_A, SESSION_B])
        )

        const result = await quiesceWslMove(
          prepareMove(),
          moveScope(),
          quiesceDeps(async () => {
            await sleepPane(SESSION_A)
            await sleepPane(SESSION_B)
          })
        )

        if (result.outcome !== 'quiesced') {
          throw new Error(`quiesce refused: ${JSON.stringify(result)}`)
        }
        // Read from the shell's own reports, not the folder it was spawned in.
        expect(result.restoreHints).toMatchObject({ staleCwdPaneKeys: [], noCwdPaneKeys: [] })
        // The daemon's census, not this process's bookkeeping, says both shells are gone.
        expect((await daemon.adapter.listSessions()).filter((s) => s.isAlive)).toEqual([])
        const [journaled] = listWslMoveCutovers(userDataPath)
        expect(journaled?.phase).toBe('quiesced')
        expect(journaled?.provenExitedSessionIds).toEqual([SESSION_A, SESSION_B])
        expect(journaled?.terminalRestoreHints).toEqual([
          { paneKey: PANE_A, cwd: sub },
          { paneKey: PANE_B, cwd: project }
        ])

        const hint = journaled?.terminalRestoreHints?.find((h) => h.paneKey === PANE_A)
        const restored = `${WORKTREE}@@cccc3333`
        await openShell(daemon.adapter, restored, hint?.cwd ?? project)
        await run(daemon.adapter, restored, 'pwd', 'PWD')
        // The line `pwd` printed, right before the marker; the echoed command line holds neither.
        expect(output.get(restored)).toContain(`${sub}\r\nPWD_42`)
      },
      TIMEOUT_MS
    )

    it(
      'refuses and lifts the fence when the daemon still runs a pane this app does not hold',
      async () => {
        await openShell(daemon.adapter, SESSION_A, project)
        // Started by another client, so this app's own PTY list cannot see it; only the census can.
        await openShell(daemon.otherAdapter, SESSION_B, project)
        await run(daemon.adapter, SESSION_A, reportCwd, 'A')
        await run(daemon.otherAdapter, SESSION_B, reportCwd, 'B')

        const result = await quiesceWslMove(
          prepareMove(),
          moveScope(),
          quiesceDeps(() => sleepPane(SESSION_A))
        )

        expect(result).toMatchObject({
          outcome: 'refused',
          reason: 'terminals-live',
          liveSessionIds: [SESSION_B],
          fenceLifted: true
        })
        expect(listWslMoveCutovers(userDataPath)).toEqual([])
        const alive = (await daemon.adapter.listSessions()).filter((s) => s.isAlive)
        expect(alive.map((s) => s.sessionId)).toEqual([SESSION_B])
      },
      TIMEOUT_MS
    )
  }
)
