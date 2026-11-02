import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: spawnMock,
  execFile: execFileMock
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../shared/app-environment'
import { installMainProcessTreeKillGate } from './own-chromium-tree-kill-guard'
import { setProcessTreeKillGate } from '@orca/process-host/process-tree-kill-gate'
import { resetSelfInitiatedTreeKillLogForTest } from './crash-reporting/self-initiated-tree-kill-log'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from './crash-reporting/crash-breadcrumb-store'
import { _resetTracerForTests, setActiveSink } from './observability/tracer'

import { signalProcessTree } from '@orca/process-host/process-tree-termination'

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

// A child-handle kill still owns the root when a PID-based tree walk is refused.
describe('a refused tree-kill still terminates the root it owns', () => {
  it('kills the runProcess root when the Windows arm of the shared choke point is refused', async () => {
    setPlatform('win32')
    const windowsChild = { pid: RENDERER_PID, kill: vi.fn(), exitCode: null, signalCode: null }

    await expect(signalProcessTree(windowsChild as never, 'SIGKILL')).resolves.toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(windowsChild.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('still signals the POSIX process group: a group only holds what Orca put in it', async () => {
    // Stale Electron metrics must not orphan an owned POSIX process group.
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
