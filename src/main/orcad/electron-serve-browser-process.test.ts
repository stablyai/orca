import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcessModule from '../../shared/child-process/run-process'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))

// Why wrap rather than fake: the provider must still go through the real spawn
// path (argv/env handling, a real pid to signal); only the program is swapped
// for a stub that speaks the sidecar's serve protocol.
vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcessModule>()),
  spawnProcess: spawnProcessMock
}))

import { ElectronServeBrowserProcess } from './electron-serve-browser-process'

const FAKE_SIDECAR = join(import.meta.dirname, '__fixtures__', 'fake-orcad-electron-sidecar.cjs')
const INSTALLED_EXECUTABLE = join('/Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca')

/** Every key the provider must strip so the sidecar cannot inherit orcad's own browser config. */
const AGENT_BROWSER_ENVIRONMENT_KEYS = [
  'AGENT_BROWSER_ARGS',
  'AGENT_BROWSER_AUTO_CONNECT',
  'AGENT_BROWSER_CDP',
  'AGENT_BROWSER_ENGINE',
  'AGENT_BROWSER_EXECUTABLE_PATH',
  'AGENT_BROWSER_HEADED',
  'AGENT_BROWSER_PROFILE',
  'AGENT_BROWSER_PROVIDER',
  'AGENT_BROWSER_SESSION',
  'AGENT_BROWSER_SESSION_NAME',
  'AGENT_BROWSER_STATE'
]

type SidecarRequest = { method: string; params: Record<string, unknown>; authToken: string | null }

const host: RuntimeBrowserCommandHost = {
  getAgentBrowserBridge: () => null,
  // Why an id distinct from the selector: it proves the registry fences on the
  // resolved worktree id, not on whatever string the caller passed.
  resolveWorktreeSelector: async (selector) => ({ id: `id-${selector}` }),
  getAuthoritativeWindow: () => {
    throw new Error('No renderer')
  },
  getAvailableAuthoritativeWindow: () => null,
  getOffscreenBrowserBackend: () => null
}

let harnessRoot: string
let logPath: string
let controlPath: string
let sidecarMode: string | undefined
let started: ElectronServeBrowserProcess[]

async function setControl(control: Record<string, unknown>): Promise<void> {
  await writeFile(controlPath, JSON.stringify(control))
}

async function sidecarRequests(): Promise<SidecarRequest[]> {
  const raw = await readFile(logPath, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SidecarRequest)
}

async function browserRequests(): Promise<SidecarRequest[]> {
  return (await sidecarRequests()).filter((request) => request.method !== 'status.get')
}

async function startProvider(): Promise<ElectronServeBrowserProcess> {
  const processHandle = new ElectronServeBrowserProcess(INSTALLED_EXECUTABLE)
  started.push(processHandle)
  await processHandle.start()
  return processHandle
}

function spawnSpec(): RunProcessModule.ProcessSpec {
  return spawnProcessMock.mock.calls[0][0] as RunProcessModule.ProcessSpec
}

beforeEach(async () => {
  harnessRoot = await mkdtemp(join(tmpdir(), 'orcad-electron-harness-'))
  logPath = join(harnessRoot, 'requests.jsonl')
  controlPath = join(harnessRoot, 'control.json')
  sidecarMode = undefined
  started = []
  await writeFile(logPath, '')
  await setControl({})
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
        ORCA_FAKE_SIDECAR_LOG: logPath,
        ORCA_FAKE_SIDECAR_CONTROL: controlPath,
        ...(sidecarMode ? { ORCA_FAKE_SIDECAR_MODE: sidecarMode } : {})
      }
    })
  )
})

afterEach(async () => {
  for (const processHandle of started) {
    await processHandle.stop()
  }
  vi.unstubAllEnvs()
  await rm(harnessRoot, { recursive: true, force: true })
})

describe('ElectronServeBrowserProcess start-up', () => {
  it('launches the installed app in headless serve mode without orcad browser env', async () => {
    for (const key of AGENT_BROWSER_ENVIRONMENT_KEYS) {
      vi.stubEnv(key, `leaked-${key}`)
    }
    vi.stubEnv('ORCA_HARNESS_UNRELATED', 'preserved')

    const processHandle = await startProvider()

    const spec = spawnSpec()
    expect(spec.program).toBe(INSTALLED_EXECUTABLE)
    const args = [...(spec.args ?? [])]
    expect(args).toEqual(
      expect.arrayContaining(['--serve', '--serve-port', '--serve-json', '--serve-no-pairing'])
    )
    const port = Number(args[args.indexOf('--serve-port') + 1])
    expect(Number.isInteger(port) && port > 0 && port < 65_536).toBe(true)
    const userDataArg = args.find((arg) => arg.startsWith('--user-data-dir='))
    expect(userDataArg).toBeDefined()
    for (const key of AGENT_BROWSER_ENVIRONMENT_KEYS) {
      expect(spec.env).not.toHaveProperty(key)
    }
    expect(spec.env?.ORCA_HARNESS_UNRELATED).toBe('preserved')
    expect(processHandle.isAvailable()).toBe(true)
  })

  it('keeps polling until the sidecar advertises browser.headless.v1', async () => {
    await setControl({
      capabilities: [['runtime.v1'], ['runtime.v1'], ['runtime.v1', 'browser.headless.v1']]
    })

    const processHandle = await startProvider()

    const statusCalls = (await sidecarRequests()).filter(
      (request) => request.method === 'status.get'
    )
    expect(statusCalls).toHaveLength(3)
    expect(processHandle.isAvailable()).toBe(true)
  })

  it('fails fast when the installed app exits before publishing runtime metadata', async () => {
    sidecarMode = 'exit-before-ready'
    const processHandle = new ElectronServeBrowserProcess(INSTALLED_EXECUTABLE)
    started.push(processHandle)

    await expect(processHandle.start()).rejects.toThrow(/did not become ready/)
    expect(processHandle.isAvailable()).toBe(false)
  })

  it('stops the sidecar process and removes its user data directory', async () => {
    const processHandle = await startProvider()
    const userDataPath = (spawnSpec().args ?? [])
      .find((arg) => arg.startsWith('--user-data-dir='))!
      .slice('--user-data-dir='.length)
    const metadata = JSON.parse(
      await readFile(join(userDataPath, 'orca-runtime.json'), 'utf8')
    ) as { pid: number }

    await processHandle.stop()

    expect(processHandle.isAvailable()).toBe(false)
    expect(existsSync(userDataPath)).toBe(false)
    expect(() => process.kill(metadata.pid, 0)).toThrow()
  })
})

describe('ElectronServeBrowserProcess command routing', () => {
  it('rejects commands before start and after stop', async () => {
    const processHandle = new ElectronServeBrowserProcess(INSTALLED_EXECUTABLE)
    await expect(
      processHandle.createCommands(host).browserGoto({ url: 'https://example.test/' })
    ).rejects.toMatchObject({ code: 'browser_unavailable' })

    const runningHandle = await startProvider()
    const commands = runningHandle.createCommands(host)
    await runningHandle.stop()
    await expect(commands.browserGoto({ url: 'https://example.test/' })).rejects.toMatchObject({
      code: 'browser_unavailable'
    })
  })

  it('refuses screencast without reaching the sidecar', async () => {
    const processHandle = await startProvider()

    await expect(
      processHandle
        .createCommands(host)
        .browserScreencast({ worktree: 'wt-a', format: 'jpeg' }, { sendBinary: () => true })
    ).rejects.toMatchObject({ code: 'browser_screencast_unavailable' })
    expect(await browserRequests()).toEqual([])
  })

  it('forwards the sidecar auth token and strips the worktree selector from params', async () => {
    const commands = (await startProvider()).createCommands(host)

    const created = (await commands.browserTabCreate({ worktree: 'wt-a' })) as {
      browserPageId: string
    }
    await commands.browserGoto({ worktree: 'wt-a', url: 'https://example.test/' })

    const requests = await browserRequests()
    expect(requests.map((request) => request.method)).toEqual(['browser.tabCreate', 'browser.goto'])
    for (const request of requests) {
      expect(request.authToken).toBe('fake-sidecar-auth-token')
      expect(request.params).not.toHaveProperty('worktree')
    }
    // The active page is targeted implicitly once the worktree resolves.
    expect(requests[1].params.page).toBe(created.browserPageId)
  })

  it('leaves targetless methods untargeted and renumbers listed tabs per worktree', async () => {
    const commands = (await startProvider()).createCommands(host)
    const first = (await commands.browserTabCreate({ worktree: 'wt-a' })) as {
      browserPageId: string
    }
    const second = (await commands.browserTabCreate({ worktree: 'wt-a' })) as {
      browserPageId: string
    }
    await commands.browserTabCreate({ worktree: 'wt-b' })

    const listed = (await commands.browserTabList({ worktree: 'wt-a' })) as {
      tabs: { browserPageId: string; index: number }[]
    }

    expect(listed.tabs).toEqual([
      expect.objectContaining({ browserPageId: first.browserPageId, index: 0 }),
      expect.objectContaining({ browserPageId: second.browserPageId, index: 1 })
    ])
    const listRequest = (await browserRequests()).find(
      (request) => request.method === 'browser.tabList'
    )
    expect(listRequest?.params).not.toHaveProperty('page')
  })

  it('fences pages to the worktree that created them without calling the sidecar', async () => {
    const commands = (await startProvider()).createCommands(host)
    const created = (await commands.browserTabCreate({ worktree: 'wt-a' })) as {
      browserPageId: string
    }
    const before = (await browserRequests()).length

    await expect(
      commands.browserGoto({
        worktree: 'wt-b',
        page: created.browserPageId,
        url: 'https://example.test/'
      })
    ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    expect(await browserRequests()).toHaveLength(before)
  })

  it('routes browserTabCurrent to browser.tabShow for the active page', async () => {
    const commands = (await startProvider()).createCommands(host)
    const created = (await commands.browserTabCreate({ worktree: 'wt-a' })) as {
      browserPageId: string
    }

    await commands.browserTabCurrent({ worktree: 'wt-a' })

    const request = (await browserRequests()).at(-1)
    expect(request?.method).toBe('browser.tabShow')
    expect(request?.params.page).toBe(created.browserPageId)
  })

  it('re-creating a known page id is idempotent and issues no sidecar request', async () => {
    const commands = (await startProvider()).createCommands(host)
    const created = (await commands.browserTabCreate({ worktree: 'wt-a' })) as {
      browserPageId: string
    }
    const before = (await browserRequests()).length

    await expect(
      commands.browserTabCreate({ worktree: 'wt-a', page: created.browserPageId })
    ).resolves.toEqual({ browserPageId: created.browserPageId })
    expect(await browserRequests()).toHaveLength(before)
  })

  it('forgets a page the sidecar reports as closed', async () => {
    const commands = (await startProvider()).createCommands(host)
    await commands.browserTabCreate({ worktree: 'wt-a' })
    await setControl({
      errors: { 'browser.goto': { code: 'browser_tab_closed', message: 'Tab was closed.' } }
    })

    await expect(
      commands.browserGoto({ worktree: 'wt-a', url: 'https://example.test/' })
    ).rejects.toMatchObject({ code: 'browser_tab_closed' })

    await setControl({})
    await expect(commands.browserTabCurrent({ worktree: 'wt-a' })).rejects.toMatchObject({
      code: 'browser_no_tab'
    })
  })

  // Why this matters: the runtime advertises browser.tabCreate.known-id.v1
  // unconditionally, so a web client will send a provisional id for a page that does
  // not exist yet. Requiring it first made every such create throw.
  it('creates a tab under a caller-chosen page id', async () => {
    const commands = (await startProvider()).createCommands(host)

    await expect(
      commands.browserTabCreate({ worktree: 'wt-a', page: 'provisional-page-1' })
    ).resolves.toEqual({ browserPageId: 'provisional-page-1' })
  })
})
