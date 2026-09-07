import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, execFileMock, queryWindowsProcessDescendantsMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  queryWindowsProcessDescendantsMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: spawnMock,
  execFile: execFileMock
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('./providers/windows-foreground-process-rows', () => ({
  queryWindowsProcessDescendants: queryWindowsProcessDescendantsMock
}))

import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../shared/app-environment'
import { installMainProcessTreeKillGate } from './own-chromium-tree-kill-guard'
import { setProcessTreeKillGate } from '../shared/child-process/process-tree-kill-gate'
import { resetSelfInitiatedTreeKillLogForTest } from './crash-reporting/self-initiated-tree-kill-log'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from './crash-reporting/crash-breadcrumb-store'
import { _resetTracerForTests, setActiveSink } from './observability/tracer'
import { terminateNotebookProcessTree } from './ipc/notebook'
import { killLocalPrecheckProcessTree } from './automations/precheck-runner'
import { killRecipeProcess } from '../shared/ephemeral-vm-recipe-process'
import { killSpawnedCommandTree } from './git/command-runner/spawned-command-tree-kill'
import { killCodexAppServerProcessTree } from './codex/codex-app-server-session'
import { signalProcessTree } from '../shared/child-process/process-tree-termination'
import { killSourceControlAgentProcess } from './text-generation/source-control-local-process'
import { terminateCodexTurnProcesses } from './codex/codex-structured-turn-processes'

/** A pid Electron reports as one of ours: every gate below must refuse it. */
const RENDERER_PID = 1001

function appEnvironment(): AppEnvironment {
  return {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: (() => [
      { pid: RENDERER_PID, type: 'Tab' }
    ]) as unknown as AppEnvironment['getAppMetrics']
  }
}

let previousEnvironment: AppEnvironment | null = null
let previousPlatform: PropertyDescriptor | undefined

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
  previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  setAppEnvironment(appEnvironment())
  setActiveSink(null)
  clearCrashBreadcrumbsForTest()
  resetSelfInitiatedTreeKillLogForTest()
  installMainProcessTreeKillGate()
  spawnMock.mockReset()
  execFileMock.mockReset()
  queryWindowsProcessDescendantsMock.mockReset()
  spawnMock.mockReturnValue({ on: vi.fn(), once: vi.fn(), unref: vi.fn(), kill: vi.fn() })
})

afterEach(() => {
  setProcessTreeKillGate(null)
  if (previousPlatform) {
    Object.defineProperty(process, 'platform', previousPlatform)
  }
  if (previousEnvironment) {
    setAppEnvironment(previousEnvironment)
  }
  _resetTracerForTests()
})

/**
 * A refusal must never become a process leak. The gate only blocks the
 * pid-addressed tree walk; the root kill is addressed by the child handle, so it
 * cannot reach the recycled pid we refused, and skipping it would report a
 * timed-out command as stopped while its tree keeps running.
 */
describe('a refused tree-kill still terminates the root it owns', () => {
  it('kills the git command root when the tree walk is refused', async () => {
    setPlatform('win32')
    const child = { pid: RENDERER_PID, kill: vi.fn() }

    await killSpawnedCommandTree(child as never)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills the notebook cell root when the tree walk is refused', () => {
    setPlatform('win32')
    const child = { pid: RENDERER_PID, kill: vi.fn() }

    expect(terminateNotebookProcessTree(child as never)).toBeNull()

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills the automation precheck root when the tree walk is refused', () => {
    setPlatform('win32')
    const child = { pid: RENDERER_PID, kill: vi.fn() }

    expect(killLocalPrecheckProcessTree(child as never)).toBeNull()

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills the ephemeral-VM recipe root when the tree walk is refused', () => {
    setPlatform('win32')
    const child = { pid: RENDERER_PID, kill: vi.fn() }

    killRecipeProcess(child as never, true)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the codex app-server root when the deadline tree walk is refused', () => {
    const child = { pid: RENDERER_PID, kill: vi.fn() }

    killCodexAppServerProcessTree(child as never, {
      platform: 'win32',
      spawnImpl: spawnMock as never
    })

    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the commit-message agent root when the tree walk is refused', async () => {
    setPlatform('win32')
    const child = { pid: RENDERER_PID, kill: vi.fn() }

    await killSourceControlAgentProcess(child as never)

    expect(execFileMock).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the runProcess root when the Windows arm of the shared choke point is refused', async () => {
    setPlatform('win32')
    const windowsChild = { pid: RENDERER_PID, kill: vi.fn(), exitCode: null, signalCode: null }

    await expect(signalProcessTree(windowsChild as never, 'SIGKILL')).resolves.toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(windowsChild.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('still signals the POSIX process group: a group only holds what Orca put in it', async () => {
    // Same contract as main and as the other three POSIX group arms in main
    // (claude-login, codex teardown, PTY sweep): record, never refuse. A stale
    // `getAppMetrics()` entry must not orphan a macOS/Linux tree.
    setPlatform('linux')
    const posixChild = { pid: RENDERER_PID, kill: vi.fn(), exitCode: null, signalCode: null }
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    await expect(signalProcessTree(posixChild as never, 'SIGKILL')).resolves.toBe(true)
    expect(processKill).toHaveBeenCalledWith(-RENDERER_PID, 'SIGKILL')
    expect(posixChild.kill).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'self_tree_kill',
        data: expect.objectContaining({ pid: RENDERER_PID, scope: 'posix-process-group' })
      })
    ])
    processKill.mockRestore()
  })
})

/**
 * The one gated site with nothing to fall back to: the roots it kills are found
 * by a process-table walk, not spawned here, so there is no child handle. A
 * refusal must then be visible — the refusal crumb is written and the turn is
 * reported as not cancelled — rather than resolving as if the tree had gone.
 */
describe('a refused tree-kill with no handle to fall back to', () => {
  it('reports the codex turn as not cancelled and records the refused added root', async () => {
    const appServerPid = 500
    const addedRoot = {
      pid: RENDERER_PID,
      ppid: appServerPid,
      name: 'node.exe',
      command: 'node',
      depth: 1
    }
    queryWindowsProcessDescendantsMock.mockResolvedValue([addedRoot])

    await expect(
      terminateCodexTurnProcesses(appServerPid, { platform: 'win32', identities: new Map() })
    ).resolves.toBe(false)

    expect(execFileMock).not.toHaveBeenCalled()
    expect(getCrashBreadcrumbSnapshot()).toEqual([
      expect.objectContaining({
        name: 'self_tree_kill_refused_own_chromium',
        data: expect.objectContaining({ pid: RENDERER_PID, site: 'codex-turn-added-roots' })
      })
    ])
  })
})
