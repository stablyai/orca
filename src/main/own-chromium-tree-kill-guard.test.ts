import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn((): { pid: number; type?: string }[] => [])
}))

import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../shared/app-environment'
import { readOrcaChromiumProcessPids } from './orca-chromium-process-pids'
import { classifyWindowsTreeKillTarget } from './windows-pty-root-identity'
import { terminateWindowsProcessTree } from './windows-process-tree-kill'
import { admitSelfInitiatedTreeKill } from './own-chromium-tree-kill-guard'
import { resetSelfInitiatedTreeKillLogForTest } from './crash-reporting/self-initiated-tree-kill-log'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from './crash-reporting/crash-breadcrumb-store'
import { _resetTracerForTests, setActiveSink } from './observability/tracer'

const ORCA_MAIN_PID = 1000
const RENDERER_PID = 1001
/** The standalone daemon is a sibling of the renderers, spawned by main. */
const DAEMON_PID = 1500

/** Orca's renderer is a direct child of the main process, so the ppid walk says `own`. */
const PROCESS_ROWS = [
  { pid: RENDERER_PID, ppid: ORCA_MAIN_PID },
  { pid: ORCA_MAIN_PID, ppid: 900 }
]

function appEnvironment(): AppEnvironment {
  return {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: appMetricsMock as unknown as AppEnvironment['getAppMetrics']
  }
}

let previousEnvironment: AppEnvironment | null = null

beforeEach(() => {
  previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
  setAppEnvironment(appEnvironment())
  appMetricsMock.mockReturnValue([
    { pid: ORCA_MAIN_PID, type: 'Browser' },
    { pid: RENDERER_PID, type: 'Tab' },
    { pid: 1002, type: 'GPU' }
  ])
  setActiveSink({ push: () => {}, flush: () => {}, close: () => {} })
  clearCrashBreadcrumbsForTest()
  resetSelfInitiatedTreeKillLogForTest()
})

afterEach(() => {
  if (previousEnvironment) {
    setAppEnvironment(previousEnvironment)
  }
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

describe('refusing to tree-kill our own Chromium processes', () => {
  it('reads the live Chromium pid set from the app environment', () => {
    expect([...readOrcaChromiumProcessPids()]).toEqual([ORCA_MAIN_PID, RENDERER_PID, 1002])
  })

  it('classifies a live renderer as foreign even though its ancestry reaches us', () => {
    expect(classifyWindowsTreeKillTarget(RENDERER_PID, PROCESS_ROWS, ORCA_MAIN_PID)).toBe('foreign')
  })

  it.each([
    ['an empty pid set', new Set<number>()],
    ['the live pid set', undefined]
  ])(
    'refuses an Orca renderer from a daemon host with %s, because no Chromium descends from it',
    (_case, ownChromiumPids) => {
      // The standalone daemon and orcad install no Chromium-backed AppEnvironment,
      // so this set is empty there. The ancestry walk is what refuses instead: it
      // ends at the *killing* process's pid, and the renderer's chain reaches main.
      const rows = [...PROCESS_ROWS, { pid: DAEMON_PID, ppid: ORCA_MAIN_PID }]

      expect(classifyWindowsTreeKillTarget(RENDERER_PID, rows, DAEMON_PID, ownChromiumPids)).toBe(
        'foreign'
      )
    }
  )

  it('is the only thing standing between Electron main and its own renderer', () => {
    // Falsifiable counterpart to the daemon case above: in main the ancestry walk
    // says `own`, so the pid set is load-bearing here and nowhere else.
    expect(
      classifyWindowsTreeKillTarget(RENDERER_PID, PROCESS_ROWS, ORCA_MAIN_PID, new Set())
    ).toBe('own')
  })

  it('still classifies a real PTY child of ours as own', () => {
    const rows = [...PROCESS_ROWS, { pid: 7777, ppid: ORCA_MAIN_PID }]

    expect(classifyWindowsTreeKillTarget(7777, rows, ORCA_MAIN_PID)).toBe('own')
  })

  it('never spawns taskkill against one of our own Chromium pids', async () => {
    const execFileImpl = vi.fn()

    await terminateWindowsProcessTree(RENDERER_PID, {
      execFileImpl: execFileImpl as never,
      site: 'pty-descendant-sweep'
    })

    expect(execFileImpl).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'self_tree_kill_refused_own_chromium',
        data: expect.objectContaining({ pid: RENDERER_PID, site: 'pty-descendant-sweep' })
      })
    ])
  })

  it('still taskkills a pid that is not one of ours', async () => {
    const execFileImpl = vi.fn((_program, _args, _options, done: () => void) => {
      done()
    })

    await terminateWindowsProcessTree(7777, {
      execFileImpl: execFileImpl as never,
      site: 'pty-descendant-sweep'
    })

    expect(execFileImpl).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '7777', '/T', '/F'],
      expect.anything(),
      expect.any(Function)
    )
  })

  it('refuses an own-Chromium pid at the gate the account teardowns share', () => {
    expect(
      admitSelfInitiatedTreeKill({
        pid: RENDERER_PID,
        site: 'claude-account-login-teardown',
        scope: 'win-taskkill-tree'
      })
    ).toBe(false)
    expect(
      admitSelfInitiatedTreeKill({
        pid: 7777,
        site: 'codex-account-login-teardown',
        scope: 'win-taskkill-tree'
      })
    ).toBe(true)
    expect(getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)).toEqual([
      'self_tree_kill_refused_own_chromium',
      'self_tree_kill'
    ])
  })
})
