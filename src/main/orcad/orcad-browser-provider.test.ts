import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import { agentBrowserCommandOf } from '../browser/agent-browser/testing/agent-browser-bridge-test-harness'
import {
  resolveInstalledElectronExecutable,
  resolveOrcadBrowserProvider
} from './orcad-browser-provider'
import {
  runtimeBrowserUnavailableCause,
  setRuntimeBrowserUnavailableCause
} from '../runtime/browser/installation/runtime-browser-commands-factory'

vi.mock('@orca/process-host', () => ({
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
    const command = agentBrowserCommandOf(spec.args ?? [], spec.input)
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
    if (command.join(' ') === 'snapshot -i --delta') {
      return success({ snapshot: { kind: 'unchanged', revision: 2, baseRevision: 1 } })
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

describe.skipIf(process.platform === 'win32')('resolveInstalledElectronExecutable', () => {
  async function writeExecutable(path: string, content: Buffer | string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
    await chmod(path, 0o755)
  }

  it('rejects a symlink to the bash CLI shim and picks the install-dir binary', async () => {
    const shim = join(root, 'share', 'orca-ide-shim')
    const link = join(root, 'bin', 'orca-ide')
    const electron = join(root, 'opt', 'Orca', 'orca-ide')
    await writeExecutable(shim, '#!/usr/bin/env bash\nexec true\n')
    await mkdir(join(link, '..'), { recursive: true })
    await symlink(shim, link)
    await writeExecutable(electron, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]))

    await expect(resolveInstalledElectronExecutable([link, electron])).resolves.toBe(electron)
    await expect(resolveInstalledElectronExecutable([link])).resolves.toBeNull()
  })
})

describe('resolveOrcadBrowserProvider', () => {
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
})
