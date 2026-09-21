import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcessModule from '../../shared/child-process/run-process'

const { runProcessMock, spawnProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcessModule>()),
  runProcess: runProcessMock,
  spawnProcess: spawnProcessMock
}))

import { resolveOrcadBrowserProvider, type OrcadBrowserProvider } from './orcad-browser-provider'

const FAKE_SIDECAR = join(import.meta.dirname, '__fixtures__', 'fake-orcad-electron-sidecar.cjs')
const INSTALLED_EXECUTABLE = join('/Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca')

let harnessRoot: string
let controlPath: string
let chromiumExecutable: string
let sidecarMode: string | undefined
let provider: OrcadBrowserProvider | null

/** Strips the session/profile/args prefix the agent-browser invocation carries. */
function commandFromArgs(args: readonly string[]): string[] {
  let index = 0
  while (['--session', '--profile', '--args'].includes(args[index] ?? '')) {
    index += 2
  }
  return args.slice(index, -1)
}

function agentBrowserSuccess(data: unknown) {
  return Promise.resolve({
    code: 0,
    signal: null,
    stdout: JSON.stringify({ success: true, data, error: null }),
    stderr: '',
    timedOut: false
  })
}

beforeEach(async () => {
  harnessRoot = await mkdtemp(join(tmpdir(), 'orcad-provider-selection-'))
  controlPath = join(harnessRoot, 'control.json')
  chromiumExecutable = join(harnessRoot, process.platform === 'win32' ? 'chromium.exe' : 'chromium')
  sidecarMode = undefined
  provider = null
  await writeFile(controlPath, '{}')
  await writeFile(chromiumExecutable, '')
  if (process.platform !== 'win32') {
    await chmod(chromiumExecutable, 0o755)
  }

  const actual = await vi.importActual<typeof RunProcessModule>(
    '../../shared/child-process/run-process'
  )
  spawnProcessMock.mockReset()
  spawnProcessMock.mockImplementation((spec: RunProcessModule.ProcessSpec) =>
    actual.spawnProcess({
      ...spec,
      program: process.execPath,
      args: [FAKE_SIDECAR, ...(spec.args ?? [])],
      env: {
        ...spec.env,
        ORCA_FAKE_SIDECAR_CONTROL: controlPath,
        ...(sidecarMode ? { ORCA_FAKE_SIDECAR_MODE: sidecarMode } : {})
      }
    })
  )
  runProcessMock.mockReset()
  runProcessMock.mockImplementation(async (spec: RunProcessModule.ProcessSpec) => {
    const command = commandFromArgs(spec.args ?? [])
    if (command[0] === 'open') {
      return agentBrowserSuccess({ url: 'about:blank', title: '' })
    }
    if (command[0] === 'tab') {
      return agentBrowserSuccess({
        tabs: [{ active: true, tabId: 't1', title: '', url: 'about:blank' }]
      })
    }
    if (command[0] === 'close') {
      return agentBrowserSuccess({ closed: true })
    }
    throw new Error(`Unexpected agent-browser command: ${command.join(' ')}`)
  })
})

afterEach(async () => {
  await provider?.stop()
  vi.restoreAllMocks()
  await rm(harnessRoot, { recursive: true, force: true })
})

describe('resolveOrcadBrowserProvider Electron preference', () => {
  it('uses the installed Electron app even when a Chromium executable is configured', async () => {
    provider = await resolveOrcadBrowserProvider({
      userDataPath: join(harnessRoot, 'state'),
      environment: { ORCA_BROWSER_EXECUTABLE: chromiumExecutable },
      resolveInstalledElectronExecutable: async () => INSTALLED_EXECUTABLE,
      resolveAgentBrowserBinary: () => '/agent-browser'
    })

    expect(provider?.kind).toBe('electron')
    expect(provider?.isAvailable()).toBe(true)
    expect(spawnProcessMock.mock.calls[0][0].program).toBe(INSTALLED_EXECUTABLE)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('falls back to the operator Chromium when the installed Electron app cannot start', async () => {
    sidecarMode = 'exit-before-ready'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    provider = await resolveOrcadBrowserProvider({
      userDataPath: join(harnessRoot, 'state'),
      environment: { ORCA_BROWSER_EXECUTABLE: chromiumExecutable },
      resolveInstalledElectronExecutable: async () => INSTALLED_EXECUTABLE,
      resolveAgentBrowserBinary: () => '/agent-browser'
    })

    expect(spawnProcessMock).toHaveBeenCalled()
    expect(provider?.kind).toBe('chromium')
    expect(warn).toHaveBeenCalledWith(
      '[orcad] Installed Electron browser provider unavailable:',
      expect.anything()
    )
  })

  it('returns no provider when Electron fails and no Chromium is configured', async () => {
    sidecarMode = 'exit-before-ready'
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    provider = await resolveOrcadBrowserProvider({
      userDataPath: join(harnessRoot, 'state'),
      environment: {},
      resolveInstalledElectronExecutable: async () => INSTALLED_EXECUTABLE,
      resolveAgentBrowserBinary: () => '/agent-browser'
    })

    expect(provider).toBeNull()
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
