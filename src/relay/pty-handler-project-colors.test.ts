import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { _resetPtyOwnerHostColorsForTest } from '../shared/pty-owner-color-query-colors'

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
  createMockDispatcher,
  createTestPtyHandler,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

// Why a real directory: spawn and revive resolve the worktree path on this host.
const LIVE_CWD = tmpdir()
const HOST = { foreground: '#000000', background: '#123456' }
const PROJECT = { foreground: '#839496', background: '#002b36' }
const HOST_REPLY = '\x1b]11;rgb:1212/3434/5656\x1b\\'
const PROJECT_REPLY = '\x1b]11;rgb:0000/2b2b/3636\x1b\\'
const QUERY = '\x1b]11;?\x07'

type SpawnedTerm = { id: string; write: ReturnType<typeof vi.fn>; emit: (data: string) => void }

function spawnedPtyId(result: unknown): string {
  if (typeof result === 'object' && result && 'id' in result && typeof result.id === 'string') {
    return result.id
  }
  throw new Error('pty.spawn answered without an id')
}

function serializedState(result: unknown): string {
  if (typeof result !== 'string') {
    throw new Error('pty.serialize answered without a state string')
  }
  return result
}

/** The next node-pty spawn answers with a term whose output the test can drive. */
function nextSpawnedTerm(): Omit<SpawnedTerm, 'id'> {
  let dataCallback: ((data: string) => void) | undefined
  const term = {
    ...mockPtyInstance,
    write: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataCallback = cb
    }),
    onExit: vi.fn()
  }
  mockPtySpawn.mockReturnValueOnce(term)
  return { write: term.write, emit: (data) => dataCallback?.(data) }
}

describe('relay PTYs answer OSC 10/11 with their project colours', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    _resetPtyOwnerHostColorsForTest()
    await endPtyHandlerTest(handler, originalPlatform)
  })

  async function spawnIn(repoId: string): Promise<SpawnedTerm> {
    const term = nextSpawnedTerm()
    const id = spawnedPtyId(
      await dispatcher.callRequest('pty.spawn', {
        shellOverride: '/bin/bash',
        cwd: LIVE_CWD,
        worktreeId: `${repoId}::${LIVE_CWD}`
      })
    )
    return { id, ...term }
  }

  function repliesOf(term: Pick<SpawnedTerm, 'write'>): string[] {
    return term.write.mock.calls.map(([data]) => String(data))
  }

  it("answers a themed project's PTY from the pushed map and every other PTY from the host colours", async () => {
    const themed = await spawnIn('repo-a')
    const plain = await spawnIn('repo-b')
    dispatcher.callNotification('pty.setColorQueryReplyColors', {
      colors: HOST,
      byRepoId: { 'repo-a': PROJECT }
    })

    themed.emit(QUERY)
    plain.emit(QUERY)
    vi.advanceTimersByTime(8)

    expect(repliesOf(themed)).toEqual([PROJECT_REPLY])
    expect(repliesOf(plain)).toEqual([HOST_REPLY])
  })

  it('keeps the map on a push without one (an older client), and clears it on an empty one', async () => {
    const themed = await spawnIn('repo-a')
    dispatcher.callNotification('pty.setColorQueryReplyColors', {
      colors: HOST,
      byRepoId: { 'repo-a': PROJECT }
    })

    dispatcher.callNotification('pty.setColorQueryReplyColors', { colors: HOST })
    themed.emit(QUERY)
    // A malformed map keeps the previous one too.
    dispatcher.callNotification('pty.setColorQueryReplyColors', { colors: HOST, byRepoId: 'x' })
    themed.emit(QUERY)
    dispatcher.callNotification('pty.setColorQueryReplyColors', { colors: HOST, byRepoId: {} })
    themed.emit(QUERY)
    vi.advanceTimersByTime(8)

    expect(repliesOf(themed)).toEqual([PROJECT_REPLY, PROJECT_REPLY, HOST_REPLY])
  })

  it("answers a revived PTY of a themed project from the project's colours", async () => {
    const { id } = await spawnIn('repo-a')
    const state = serializedState(await dispatcher.callRequest('pty.serialize', { ids: [id] }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const restored = createMockDispatcher()
    const restoredHandler = createTestPtyHandler(restored)
    const revived = nextSpawnedTerm()
    try {
      await restored.callRequest('pty.revive', { state })
      restored.callNotification('pty.setColorQueryReplyColors', {
        colors: HOST,
        byRepoId: { 'repo-a': PROJECT }
      })
      revived.emit(QUERY)
      vi.advanceTimersByTime(8)

      expect(repliesOf(revived)).toEqual([PROJECT_REPLY])
    } finally {
      killSpy.mockRestore()
      await restoredHandler.dispose({ waitForPhysicalExit: false }).catch(() => {})
    }
  })
})
