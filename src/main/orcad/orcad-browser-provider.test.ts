import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import { installedElectronCandidates, resolveOrcadBrowserProvider } from './orcad-browser-provider'
import { orcadAgentBrowserNativeName } from './orcad-agent-browser-binary'
import {
  runtimeBrowserUnavailableCause,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  spawnProcess: vi.fn()
}))

type BrowserState = {
  activeTabId: string
  tabs: { active: boolean; tabId: string; title: string; url: string }[]
}

const runProcessMock = vi.mocked(runProcess)
const spawnProcessMock = vi.mocked(spawnProcess)
let root: string
let screenshotPath: string
let browserState: BrowserState

function commandFromArgs(args: readonly string[]): string[] {
  let index = 0
  while (['--session', '--profile', '--args'].includes(args[index] ?? '')) {
    index += 2
  }
  return args.slice(index, -1)
}

function success(data: unknown) {
  return Promise.resolve({
    code: 0,
    signal: null,
    stdout: JSON.stringify({ success: true, data, error: null }),
    stderr: '',
    timedOut: false
  })
}

function installAgentBrowserMock(): void {
  runProcessMock.mockImplementation(async (spec) => {
    const command = commandFromArgs(spec.args ?? [])
    if (command[0] === 'open') {
      const active = browserState.tabs.find((tab) => tab.tabId === browserState.activeTabId)!
      active.url = command[1]
      active.title = command[1] === 'about:blank' ? '' : 'Fixture page'
      return success({ url: active.url, title: active.title })
    }
    if (command[0] === 'tab' && command.length === 1) {
      return success({
        tabs: browserState.tabs.map((tab) => ({
          ...tab,
          active: tab.tabId === browserState.activeTabId
        }))
      })
    }
    if (command[0] === 'tab' && command.length === 2) {
      browserState.activeTabId = command[1]
      return success({ tabId: command[1] })
    }
    if (command[0] === 'eval') {
      return success({ result: 'Fixture page', origin: 'https://fixture.test/' })
    }
    if (command[0] === 'screenshot') {
      return success({ path: screenshotPath })
    }
    if (command[0] === 'close') {
      return success({ closed: true })
    }
    throw new Error(`Unexpected agent-browser command: ${command.join(' ')}`)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orcad-browser-provider-'))
  screenshotPath = join(root, 'fixture.png')
  await writeFile(screenshotPath, Buffer.from('fixture-image'))
  browserState = {
    activeTabId: 't1',
    tabs: [{ active: true, tabId: 't1', title: '', url: 'about:blank' }]
  }
  runProcessMock.mockReset()
  spawnProcessMock.mockReset()
  installAgentBrowserMock()
  setRuntimeBrowserUnavailableCause(null)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ExternalChromiumBrowserProcess', () => {
  it('navigates, evaluates, and screenshots through the operator browser', async () => {
    const processHandle = new ExternalChromiumBrowserProcess(
      '/agent-browser',
      { executablePath: '/operator/chromium', provider: 'chromium' },
      root
    )
    await processHandle.start()
    const commands = processHandle.createCommands({
      getAgentBrowserBridge: () => null,
      resolveWorktreeSelector: async (selector) => ({ id: selector }),
      resolveBrowserWorkspace: async (selector) => ({ id: selector }),
      // Unused by the sidecar command paths under test; the daemon's real host is
      // OrcaRuntimeService, which owns the client-hosted registries.
      resolveBrowserNetworkExecutionHost: () => {
        throw new Error('No browser network execution host')
      },
      getBrowserHostLeaseRegistry: () => {
        throw new Error('No browser host lease registry')
      },
      getRuntimeBrowserPageRegistry: () => {
        throw new Error('No runtime browser page registry')
      },
      getAuthoritativeWindow: () => {
        throw new Error('No renderer')
      },
      getAvailableAuthoritativeWindow: () => null,
      getOffscreenBrowserBackend: () => null
    })

    await expect(
      commands.browserTabCreate({
        url: 'https://fixture.test/',
        worktree: 'worktree-1',
        page: 'page-1'
      })
    ).resolves.toEqual({ browserPageId: 'page-1' })
    await expect(
      commands.browserGoto({
        url: 'https://fixture.test/next',
        worktree: 'worktree-1',
        page: 'page-1'
      })
    ).resolves.toEqual({ url: 'https://fixture.test/next', title: 'Fixture page' })
    await expect(
      commands.browserEval({
        expression: 'document.title',
        worktree: 'worktree-1',
        page: 'page-1'
      })
    ).resolves.toEqual({ result: 'Fixture page', origin: 'https://fixture.test/' })
    await expect(
      commands.browserScreenshot({ format: 'png', worktree: 'worktree-1', page: 'page-1' })
    ).resolves.toEqual({ data: Buffer.from('fixture-image').toString('base64'), format: 'png' })
    await expect(
      commands.browserExec({
        page: 'page-1',
        worktree: 'worktree-1',
        command:
          '--session stolen --cdp 9222 --profile /tmp/stolen --executable-path /bad --args bad eval document.title'
      })
    ).resolves.toEqual({ result: 'Fixture page', origin: 'https://fixture.test/' })
    const execArgs = runProcessMock.mock.calls.at(-1)?.[0].args ?? []
    expect(execArgs).not.toContain('stolen')
    expect(execArgs).not.toContain('9222')
    expect(execArgs).not.toContain('/tmp/stolen')
    expect(execArgs).not.toContain('/bad')

    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_BROWSER_EXECUTABLE_PATH: '/operator/chromium' })
      })
    )
    await processHandle.stop()
  })
})

describe('cross-platform browser provider paths', () => {
  it('resolves installed Electron launchers on macOS, Linux, and Windows', () => {
    expect(installedElectronCandidates('darwin', '/Users/test', {})).toContain(
      '/Users/test/Applications/Orca.app/Contents/MacOS/Orca'
    )
    expect(installedElectronCandidates('linux', '/home/test', {})).toContain(
      '/home/test/.local/bin/orca-ide'
    )
    expect(
      installedElectronCandidates('win32', 'C:\\Users\\test', {
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local'
      })
    ).toContain('C:\\Users\\test\\AppData\\Local\\Programs\\Orca\\Orca.exe')
  })

  it('uses platform-specific bundled agent-browser names', () => {
    expect(orcadAgentBrowserNativeName('darwin', 'arm64')).toBe('agent-browser-darwin-arm64')
    expect(orcadAgentBrowserNativeName('linux', 'x64')).toBe('agent-browser-linux-x64')
    expect(orcadAgentBrowserNativeName('win32', 'x64')).toBe('agent-browser-win32-x64.exe')
  })
})

describe('resolveOrcadBrowserProvider', () => {
  it('uses ORCA_BROWSER_EXECUTABLE when Electron is absent', async () => {
    const executable = join(root, process.platform === 'win32' ? 'chromium.exe' : 'chromium')
    await writeFile(executable, '')
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755)
    }

    const provider = await resolveOrcadBrowserProvider({
      userDataPath: root,
      environment: { ORCA_BROWSER_EXECUTABLE: executable },
      resolveInstalledElectronExecutable: async () => null,
      resolveAgentBrowserBinary: () => '/agent-browser'
    })

    expect(provider?.kind).toBe('chromium')
    await provider?.stop()
  })

  it('returns no provider when neither executable resolves', async () => {
    await expect(
      resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: {},
        resolveInstalledElectronExecutable: async () => null,
        resolveAgentBrowserBinary: () => '/agent-browser'
      })
    ).resolves.toBeNull()
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'unconfigured' })
  })

  it('reports a missing driver rather than falling through as unconfigured', async () => {
    const executable = join(root, 'chromium')
    await writeFile(executable, '')
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755)
    }

    await expect(
      resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: executable },
        resolveInstalledElectronExecutable: async () => null,
        resolveAgentBrowserBinary: () => null
      })
    ).resolves.toBeNull()
    expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'driver_missing' })
  })

  it('reports an ORCA_BROWSER_EXECUTABLE path that does not exist', async () => {
    const missing = join(root, 'absent-chromium')

    await expect(
      resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: missing },
        resolveInstalledElectronExecutable: async () => null,
        resolveAgentBrowserBinary: () => '/agent-browser'
      })
    ).resolves.toBeNull()
    expect(runtimeBrowserUnavailableCause()).toEqual({
      reason: 'executable_not_found',
      detail: missing
    })
  })

  it.skipIf(process.platform === 'win32')(
    'separates a non-executable ORCA_BROWSER_EXECUTABLE from a missing one',
    async () => {
      const executable = join(root, 'unchmodded-chromium')
      await writeFile(executable, '')
      await chmod(executable, 0o644)

      await expect(
        resolveOrcadBrowserProvider({
          userDataPath: root,
          environment: { ORCA_BROWSER_EXECUTABLE: executable },
          resolveInstalledElectronExecutable: async () => null,
          resolveAgentBrowserBinary: () => '/agent-browser'
        })
      ).resolves.toBeNull()
      expect(runtimeBrowserUnavailableCause()).toEqual({
        reason: 'executable_not_executable',
        detail: executable
      })
    }
  )

  it('reports a failed Electron start instead of staying invisible to the client', async () => {
    spawnProcessMock.mockImplementation(() => {
      throw new Error('spawn ENOENT')
    })

    await expect(
      resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: {},
        resolveInstalledElectronExecutable: async () => '/opt/Orca/orca-ide',
        resolveAgentBrowserBinary: () => '/agent-browser'
      })
    ).resolves.toBeNull()
    expect(runtimeBrowserUnavailableCause()).toEqual({
      reason: 'electron_start_failed',
      detail: 'spawn ENOENT'
    })
  })

  it('prefers the configured Chromium fault over an earlier Electron failure', async () => {
    spawnProcessMock.mockImplementation(() => {
      throw new Error('spawn ENOENT')
    })

    await expect(
      resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: join(root, 'absent-chromium') },
        resolveInstalledElectronExecutable: async () => '/opt/Orca/orca-ide',
        resolveAgentBrowserBinary: () => null
      })
    ).resolves.toBeNull()
    expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'driver_missing' })
  })

  it('reports a failed Chromium launch with the underlying error', async () => {
    const executable = join(root, 'chromium')
    await writeFile(executable, '')
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755)
    }
    runProcessMock.mockRejectedValue(new Error('spawn EACCES'))

    await expect(
      resolveOrcadBrowserProvider({
        userDataPath: root,
        environment: { ORCA_BROWSER_EXECUTABLE: executable },
        resolveInstalledElectronExecutable: async () => null,
        resolveAgentBrowserBinary: () => '/agent-browser'
      })
    ).resolves.toBeNull()
    expect(runtimeBrowserUnavailableCause()).toEqual({
      reason: 'chromium_start_failed',
      detail: 'spawn EACCES'
    })
  })

  it('clears any recorded cause once a provider resolves', async () => {
    const executable = join(root, 'chromium')
    await writeFile(executable, '')
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755)
    }
    setRuntimeBrowserUnavailableCause({ reason: 'driver_missing' })

    const provider = await resolveOrcadBrowserProvider({
      userDataPath: root,
      environment: { ORCA_BROWSER_EXECUTABLE: executable },
      resolveInstalledElectronExecutable: async () => null,
      resolveAgentBrowserBinary: () => '/agent-browser'
    })

    expect(provider?.kind).toBe('chromium')
    expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'unknown' })
    await provider?.stop()
  })
})
