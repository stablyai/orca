import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import os from 'node:os'
import type { MemorySnapshotStore } from './collector'

const { runProcessMock, execMock, listRegisteredPtysMock, readFileMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  execMock: vi.fn(),
  listRegisteredPtysMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  readFile: (path: string, encoding: string) => readFileMock(path, encoding)
}))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb)
}))

vi.mock('@orca/process-host', () => ({
  runProcess: (spec: { program: string; args?: string[] }) => runProcessMock(spec)
}))

vi.mock('./pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (path: string) => path.endsWith('orca-process-footprint') || actual.existsSync(path)
  }
})

const WORKTREE_A = 'repo-1::/Users/x/orca/workspaces/repo/alpha'
const WORKTREE_GONE = 'repo-1::/Users/x/orca/workspaces/repo/deleted-one'
const PANE_A = 'tab-a:pane-a'
const INHERITED_PANE = 'tab-old:pane-old'
const DAEMON = 200

const emptyStore = {
  getFolderWorkspace: () => undefined,
  getProjectGroups: () => [],
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} satisfies MemorySnapshotStore

async function loadCollector() {
  vi.resetModules()
  const { setAppEnvironment } = await import('../../shared/app-environment')
  setAppEnvironment({
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  const { setLocalDaemonPidReader } = await import('./local-daemon-pid')
  setLocalDaemonPidReader(() => DAEMON)
  return await import('./collector')
}

describe('collectMemorySnapshot outside terminals', () => {
  const originalPaneKey = process.env.ORCA_PANE_KEY

  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    process.env.ORCA_PANE_KEY = INHERITED_PANE
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'pty-a', worktreeId: WORKTREE_A, sessionId: 'pty-a', paneKey: PANE_A, pid: 210 }
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = originalPaneKey
    }
  })

  it('charges processes that left their terminal to the workspace their tag names', async () => {
    // pid, ppid, footprint bytes, pane tag
    const table: [number, number, number, string | null][] = [
      [DAEMON, 1, 100, null],
      [210, DAEMON, 1_000, `${WORKTREE_A}\t${PANE_A}`],
      [211, 210, 2_000, `${WORKTREE_A}\t${PANE_A}`],
      // Left behind when its terminal closed, with a child that cleared its environment.
      [300, 1, 40_000, `${WORKTREE_A}\t${PANE_A}`],
      [301, 300, 5_000, null],
      // From a workspace that no longer has a terminal.
      [400, 1, 7_000, `${WORKTREE_GONE}\ttab-g:pane-g`],
      [500, 1, 9_000, null],
      // Started by Orca, which inherited this pane's tag from the terminal it was opened in.
      [600, 1, 11_000, `${WORKTREE_A}\t${INHERITED_PANE}`],
      [process.pid, 1, 50, null],
      [700, process.pid, 13_000, `${WORKTREE_A}\t${PANE_A}`]
    ]
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: table.map(([pid, ppid]) => `${pid} ${ppid} 0 1`).join('\n') })
    )
    runProcessMock.mockImplementation((spec: { program: string; args?: string[] }) => {
      const result = (stdout: string, code = 0) =>
        Promise.resolve({ code, signal: null, stdout, stderr: '', timedOut: false })
      if (!spec.program.endsWith('orca-process-footprint')) {
        return result('', 1)
      }
      if (spec.args?.[0] === '--pane-identity') {
        const asked = new Set(spec.args.slice(1).map(Number))
        return result(
          table
            .filter(([pid, , , tag]) => tag !== null && asked.has(pid))
            .map(([pid, , , tag]) => `${pid}\t${tag}\n`)
            .join('')
        )
      }
      return result(table.map(([pid, , bytes]) => `${pid} ${bytes}`).join('\n'))
    })
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    const byId = new Map(snapshot.worktrees.map((worktree) => [worktree.worktreeId, worktree]))
    expect([...byId.keys()].sort()).toEqual([WORKTREE_A, WORKTREE_GONE])
    expect(byId.get(WORKTREE_A)).toMatchObject({
      memory: 48_000,
      sessions: [{ sessionId: 'pty-a', memory: 3_000 }],
      outsideTerminals: { memory: 45_000, pids: [300, 301] }
    })
    expect(byId.get(WORKTREE_GONE)).toMatchObject({
      worktreeName: 'deleted-one',
      memory: 7_000,
      sessions: [],
      outsideTerminals: { memory: 7_000, pids: [400] }
    })
    expect(snapshot.totalMemory).toBe(100 + 3_000 + 45_000 + 7_000)
  })

  it('reads the tag from /proc on Linux, where orphans go to the user manager', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    // pid ppid pcpu rss(KB): the daemon, its terminal, systemd --user, and a server it adopted.
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, {
        stdout: [`${DAEMON} 1 0 1`, `210 ${DAEMON} 0 2`, '900 1 0 4', '901 900 0 64'].join('\n')
      })
    )
    readFileMock.mockImplementation((path: string) =>
      path === '/proc/901/environ'
        ? Promise.resolve(`HOME=/home/x\0ORCA_WORKTREE_ID=${WORKTREE_A}\0ORCA_PANE_KEY=${PANE_A}\0`)
        : Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    )
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees).toHaveLength(1)
    expect(snapshot.worktrees[0]).toMatchObject({
      worktreeId: WORKTREE_A,
      memory: (2 + 64) * 1024,
      outsideTerminals: { memory: 64 * 1024, pids: [901] }
    })
  })
})
