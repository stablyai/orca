import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createTestPtyHandler,
  endPtyHandlerTest,
  testPtyId
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
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
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

const ownerEnv = {
  ORCA_PI_STATUS_OWNED: '1234',
  ORCA_PRIME_AGENT_STATUS_OWNED: '1234',
  ORCA_PI_TITLE_MARKER_OWNED: '1234'
}
const terminalEnv = {
  ORCA_PANE_KEY: 'tab:11111111-1111-4111-8111-111111111111',
  ORCA_TAB_ID: 'tab',
  ORCA_WORKTREE_ID: 'folder:workspace',
  ORCA_AGENT_LAUNCH_TOKEN: 'new-launch',
  ORCA_AGENT_HOOK_TOKEN: 'receiver-token',
  KEEP_ME: 'terminal-value'
}

describe('independent SSH terminal Pi ownership', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest(mocks))
  })
  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    vi.unstubAllEnvs()
  })

  it.each(['host', 'request', 'augmenter'] as const)(
    'drops the %s owner while keeping the new pane identity and hook coordinates',
    async (source) => {
      if (source === 'host') {
        for (const [key, value] of Object.entries(ownerEnv)) {
          vi.stubEnv(key, value)
        }
      }
      if (source === 'augmenter') {
        handler.addEnvAugmenter(() => ({ ...ownerEnv }))
      }
      await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        env: { ...terminalEnv, ...(source === 'request' ? ownerEnv : {}) }
      })
      const env = mocks.mockPtySpawn.mock.calls.at(-1)?.[2].env
      for (const key of Object.keys(ownerEnv)) {
        expect(env).not.toHaveProperty(key)
      }
      expect(env).toMatchObject(terminalEnv)
    }
  )

  it('also isolates a revived terminal from the relay process owner', async () => {
    for (const [key, value] of Object.entries(ownerEnv)) {
      vi.stubEnv(key, value)
    }
    await dispatcher.callRequest('pty.spawn', { env: terminalEnv })
    const state = await dispatcher.callRequest('pty.serialize', { ids: [testPtyId(1)] })
    await handler.dispose({ waitForPhysicalExit: false })
    mocks.mockPtySpawn.mockClear()
    dispatcher = createMockDispatcher()
    handler = createTestPtyHandler(dispatcher)
    await dispatcher.callRequest('pty.revive', { state })

    expect(mocks.mockPtySpawn).toHaveBeenCalledOnce()
    const env = mocks.mockPtySpawn.mock.calls.at(-1)?.[2].env
    for (const key of Object.keys(ownerEnv)) {
      expect(env).not.toHaveProperty(key)
    }
    expect(env.ORCA_PANE_KEY).toBe(terminalEnv.ORCA_PANE_KEY)
  })
})
