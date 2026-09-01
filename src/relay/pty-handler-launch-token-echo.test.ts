import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
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

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'
import { LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION } from '../shared/agent-launch-token-echo-protocol'

type ListedProcess = { id: string; launchToken?: string }

describe('relay launch-token echo', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  async function listProcesses(): Promise<ListedProcess[]> {
    return (await dispatcher.callRequest('pty.listProcesses')) as ListedProcess[]
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('advertises the echo version it actually implements', async () => {
    const capabilities = (await dispatcher.callRequest('pty.getCapabilities')) as {
      launchTokenEchoVersion?: number
    }
    expect(capabilities.launchTokenEchoVersion).toBe(LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION)

    const { id } = await spawnPty({ launchToken: 'tok-live' })
    expect((await listProcesses()).find((p) => p.id === id)?.launchToken).toBe('tok-live')
  })

  // Why: reconciliation reads a missing token as "no such launch", so a token that
  // never round-trips must not exist alongside an advertised echo capability.
  it('omits the field for tokenless and out-of-bounds spawns', async () => {
    const tokenless = await spawnPty({})
    const oversized = await spawnPty({ launchToken: 'x'.repeat(129) })
    const nonString = await spawnPty({ launchToken: 42 })
    const listed = await listProcesses()
    for (const { id } of [tokenless, oversized, nonString]) {
      const entry = listed.find((p) => p.id === id)
      expect(entry).toBeDefined()
      expect(entry && 'launchToken' in entry).toBe(false)
    }
  })
})
