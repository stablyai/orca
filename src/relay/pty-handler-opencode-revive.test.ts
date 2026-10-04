import './mock-descendant-sweep'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getOpenCodeCliCapabilities } from '../shared/opencode-cli-version'
import { applyOpenCodePluginSelection } from './opencode-plugin-selection'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createTestPtyHandler,
  endPtyHandlerTest,
  testPtyId,
  type MockDispatcher
} from './pty-handler-test-harness'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  probe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))
vi.mock('../main/opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: mocks.probe
}))

let dispatcher: MockDispatcher
let handler: PtyHandler
let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest(mocks))
  mocks.probe.mockReset()
})

afterEach(async () => endPtyHandlerTest(handler, originalPlatform))

function spawnedEnvironment(): Record<string, unknown> {
  const options: unknown = mocks.mockPtySpawn.mock.calls.at(-1)?.[2]
  if (
    !options ||
    typeof options !== 'object' ||
    !('env' in options) ||
    !options.env ||
    typeof options.env !== 'object'
  ) {
    throw new Error('Expected a PTY spawn environment')
  }
  return Object.fromEntries(Object.entries(options.env))
}

async function serialize(): Promise<string> {
  const state = await dispatcher.callRequest('pty.serialize', { ids: [testPtyId(1)] })
  if (typeof state !== 'string') {
    throw new Error('Expected serialized PTY state')
  }
  return state
}

async function restartHandler(): Promise<void> {
  await handler.dispose({ waitForPhysicalExit: false })
  dispatcher = createMockDispatcher()
  handler = createTestPtyHandler(dispatcher)
  mocks.mockPtySpawn.mockClear()
}

it.each(['1.18.32', '2.0.16'])(
  'preserves host-selected plugin exports through two relay revives on %s',
  async (version) => {
    const capabilities = getOpenCodeCliCapabilities(version)
    mocks.probe.mockResolvedValue(capabilities)
    await dispatcher.callRequest('pty.spawn', {
      cwd: tmpdir(),
      command: 'opencode --standalone',
      launchAgent: 'opencode',
      env: { ORCA_PANE_KEY: 'tab-oc:leaf', ORCA_OPENCODE_PLUGIN_API: 'untrusted' },
      envToDelete: ['ORCA_OPENCODE_PLUGIN_API', 'ORCA_OPENCODE_PLUGIN_API']
    })
    expect(spawnedEnvironment().ORCA_OPENCODE_PLUGIN_API).toBe(capabilities.pluginApi)
    const state = await serialize()
    expect(JSON.parse(state)).toMatchObject([
      { openCodeCapabilities: capabilities, envToDelete: [] }
    ])

    await restartHandler()
    await dispatcher.callRequest('pty.revive', { state })
    expect(spawnedEnvironment().ORCA_OPENCODE_PLUGIN_API).toBe(capabilities.pluginApi)
    const second = await serialize()
    await restartHandler()
    await dispatcher.callRequest('pty.revive', { state: second })
    expect(spawnedEnvironment().ORCA_OPENCODE_PLUGIN_API).toBe(capabilities.pluginApi)
    expect(mocks.probe).toHaveBeenCalledOnce()
  }
)

it.each([
  undefined,
  { version: 'garbage', pluginApi: 'v1' },
  { version: '3.0.0', pluginApi: 'v1' },
  { version: 2, pluginApi: 'v1' }
])('keeps legacy or unverifiable serialized selection unset: %j', async (openCodeCapabilities) => {
  handler.addEnvAugmenter(() => ({ ORCA_OPENCODE_PLUGIN_API: 'v1' }))
  await dispatcher.callRequest('pty.revive', {
    state: JSON.stringify([
      {
        id: testPtyId(1),
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: tmpdir(),
        ...(openCodeCapabilities ? { openCodeCapabilities } : {})
      }
    ])
  })
  expect(spawnedEnvironment().ORCA_OPENCODE_PLUGIN_API).toBeUndefined()
  expect(mocks.probe).not.toHaveBeenCalled()
})

it('carries a selected API into WSL without dropping other forwarded keys', () => {
  const env = { WSLENV: 'XDG_DATA_HOME/p', ORCA_OPENCODE_PLUGIN_API: 'untrusted' }
  const envToDelete = ['ORCA_OPENCODE_PLUGIN_API', 'OTHER_ENV']
  applyOpenCodePluginSelection(env, envToDelete, getOpenCodeCliCapabilities('1.18.32'), true)
  expect(env).toMatchObject({
    ORCA_OPENCODE_PLUGIN_API: 'v1',
    WSLENV: 'XDG_DATA_HOME/p:ORCA_OPENCODE_PLUGIN_API'
  })
  expect(envToDelete).toEqual(['OTHER_ENV'])
})
