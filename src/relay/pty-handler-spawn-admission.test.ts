import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ptyShellUtils from './pty-shell-utils'
import * as processTableSnapshotReader from '../shared/process-table-snapshot-reader'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
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

import { MAX_RELAY_PTY_SESSIONS, PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createPtyRequestHelpers,
  createTestPtyHandler,
  testPtyId,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty, attachPty } = createPtyRequestHelpers(() => dispatcher)

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

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('pty.spawn')
    expect(methods).toContain('pty.attach')
    expect(methods).toContain('pty.shutdown')
    expect(methods).toContain('pty.sendSignal')
    expect(methods).toContain('pty.getCwd')
    expect(methods).toContain('pty.getInitialCwd')
    expect(methods).toContain('pty.clearBuffer')
    expect(methods).toContain('pty.hasChildProcesses')
    expect(methods).toContain('pty.getForegroundProcess')
    expect(methods).toContain('pty.inspectProcess')
    expect(methods).toContain('pty.listProcesses')
    expect(methods).toContain('pty.getDefaultShell')

    const notifMethods = Array.from(dispatcher._notificationHandlers.keys())
    expect(notifMethods).toContain('pty.data')
    expect(notifMethods).toContain('pty.resize')
    // Why not `toContain('pty.ackData')`: PtyHandler must NOT own that method. It used to
    // register a no-op here, which survived only because the consumer session adapter was
    // constructed later and overwrote it (STA-4571).
    expect(notifMethods).not.toContain('pty.ackData')
  })

  it('rescans the process table for a close decision but not for a poll', async () => {
    const hasChildren = vi.mocked(ptyShellUtils.processHasChildren)
    const snapshot = vi
      .spyOn(processTableSnapshotReader, 'getStrictProcessTableSnapshotWithAge')
      .mockResolvedValue({
        rows: [
          {
            pid: mockPtyInstance.pid,
            ppid: 1,
            pgid: mockPtyInstance.pid,
            tpgid: mockPtyInstance.pid,
            stat: 'S+',
            tty: '/dev/pts/1',
            startTime: '1',
            command: 'bash'
          }
        ],
        capturedAgeMs: 0
      })
    const { id } = (await spawnPty({ cols: 80, rows: 24 })) as { id: string }
    hasChildren.mockClear()

    await dispatcher.callRequest('pty.inspectProcess', { id })
    // The poll shares the TTL-cached process table used for the foreground lookup,
    // so it does not fork a separate child-process probe.
    expect(snapshot).toHaveBeenCalledOnce()
    expect(hasChildren).not.toHaveBeenCalled()

    await dispatcher.callRequest('pty.hasChildProcesses', { id })
    // This RPC only ever gates a destructive decision (window close, workspace
    // cleanup), so it has to see a child started inside the 500ms window.
    expect(hasChildren).toHaveBeenLastCalledWith(mockPtyInstance.pid, { fresh: true })
  })

  it('rejects strict process inspection for a missing relay PTY', async () => {
    await expect(dispatcher.callRequest('pty.inspectProcess', { id: 'missing' })).rejects.toThrow(
      'terminal_gone'
    )
  })

  it('spawns a PTY and returns an id', async () => {
    const result = await spawnPty({ cols: 80, rows: 24 })
    expect(result).toEqual({ id: testPtyId(1), incarnationId: expect.any(String) })
    expect(mockPtySpawn).toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
  })

  it('replays an operation-owned spawn after its first response becomes stale', async () => {
    const operationId = 'a'.repeat(43)

    await dispatcher.callRequest(
      'pty.spawn',
      { cols: 80, rows: 24, agentSessionCreateOperationId: operationId },
      { isStale: () => mockPtySpawn.mock.calls.length > 0 }
    )
    const replayed = await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      agentSessionCreateOperationId: operationId
    })

    expect(replayed).toEqual({ id: testPtyId(1), incarnationId: expect.any(String) })
    expect(mockPtySpawn).toHaveBeenCalledOnce()
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
  })

  it('retains an operation fence when publication fails after native spawn', async () => {
    const operationId = 'f'.repeat(43)
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(() => {
        throw new Error('listener publication failed')
      })
    })
    const request = {
      cols: 80,
      rows: 24,
      agentSessionCreateOperationId: operationId
    }

    await expect(dispatcher.callRequest('pty.spawn', request)).rejects.toThrow(
      'listener publication failed'
    )
    await expect(dispatcher.callRequest('pty.spawn', request)).rejects.toThrow(
      'listener publication failed'
    )
    expect(mockPtySpawn).toHaveBeenCalledOnce()
    expect(handler.activePtyCount).toBe(1)
  })

  it('releases a canceled operation before native spawn after module preflight', async () => {
    let finishModuleLoad!: (value: { spawn: typeof mockPtySpawn }) => void
    const moduleLoad = new Promise<{ spawn: typeof mockPtySpawn }>((resolve) => {
      finishModuleLoad = resolve
    })
    const internals = handler as unknown as {
      loadPty(): Promise<{ spawn: typeof mockPtySpawn } | null>
    }
    const loadPty = vi.spyOn(internals, 'loadPty').mockReturnValueOnce(moduleLoad)
    const abort = new AbortController()
    const operationId = 'c'.repeat(43)
    const request = { cols: 80, rows: 24, agentSessionCreateOperationId: operationId }
    const spawning = dispatcher.callRequest('pty.spawn', request, {
      isStale: () => abort.signal.aborted,
      signal: abort.signal
    })

    abort.abort()
    finishModuleLoad({ spawn: mockPtySpawn })
    await expect(spawning).rejects.toThrow('client_disconnected')
    expect(mockPtySpawn).not.toHaveBeenCalled()

    loadPty.mockResolvedValue({ spawn: mockPtySpawn })
    await expect(dispatcher.callRequest('pty.spawn', request)).resolves.toMatchObject({
      id: testPtyId(2)
    })
    expect(mockPtySpawn).toHaveBeenCalledOnce()
  })

  it('rejects malformed create operation ids before spawning', async () => {
    await expect(
      dispatcher.callRequest('pty.spawn', { agentSessionCreateOperationId: 'not-valid' })
    ).rejects.toThrow('agent_session_operation_invalid')
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  it('adopts only the exact claimed owner generation on relay retry', async () => {
    const agentSessionEnsure = {
      claim: {
        digestVersion: 1,
        keyId: 'claim-key',
        identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent: 'codex'
      },
      surface: {
        worktreeId: 'repo::/tmp/worktree',
        tabId: '11111111-1111-4111-8111-111111111111',
        leafId: '22222222-2222-4222-8222-222222222222',
        terminalHandle: 'term_claimed'
      }
    }

    const first = (await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      agentSessionEnsure
    })) as Record<string, unknown>
    const second = (await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      agentSessionEnsure
    })) as Record<string, unknown>

    expect(first).toMatchObject({
      id: testPtyId(1),
      agentSessionEnsure: { disposition: 'created' }
    })
    expect(second).toMatchObject({
      id: testPtyId(1),
      agentSessionEnsure: { disposition: 'adopted' }
    })
    expect(second.agentSessionEnsure).toMatchObject({
      owner: (first.agentSessionEnsure as { owner: unknown }).owner
    })
    expect(mockPtySpawn).toHaveBeenCalledOnce()
  })

  it('normalizes a missing native binding as degraded node-pty availability', async () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error(
        'Failed to load native module: conpty.node, checked: build/Release, prebuilds/win32-x64'
      )
    })

    await expect(dispatcher.callRequest('pty.spawn', {})).rejects.toThrow(
      'Remote terminals are unavailable'
    )
    expect(handler.activePtyCount).toBe(0)
  })

  it('keeps the load error it was handed instead of replacing it with guesses', async () => {
    // #17830: the user got three remedies for four possible faults and could verify none.
    // The relay must carry what it was actually told, and must not prescribe a toolchain
    // install it never probed for.
    const thrown =
      'Failed to load native module: conpty.node, checked: build/Release, prebuilds/win32-x64'
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error(thrown)
    })

    const message = await dispatcher.callRequest('pty.spawn', {}).then(
      () => '',
      (error: Error) => error.message
    )

    expect(message).toContain(thrown)
    expect(message).not.toContain('install make, a C++ compiler, and python3')
    // Nothing here established a cause — the relay's node-pty directory is not on disk in
    // this harness — so per docs/reference/ssh-execution-boundary.md it must say so rather
    // than pick a diagnosis. Every message still names the host, for the bug report.
    expect(message).toContain('could not establish why')
    expect(message).toMatch(/Host: linux\/\w+, .*Node v[\d.]+ \(ABI \d+\)/)
  })

  it('preserves unrelated node-pty spawn failures', async () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error('File not found: missing-shell.exe')
    })

    await expect(dispatcher.callRequest('pty.spawn', {})).rejects.toThrow(
      'File not found: missing-shell.exe'
    )
  })

  it('atomically caps concurrent PTY spawn admission', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_RELAY_PTY_SESSIONS + 1 }, () =>
        dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 })
      )
    )

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      MAX_RELAY_PTY_SESSIONS
    )
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'Maximum number of PTY sessions reached (50)' })
    })
    expect(mockPtySpawn).toHaveBeenCalledTimes(MAX_RELAY_PTY_SESSIONS)
    expect(handler.activePtyCount).toBe(MAX_RELAY_PTY_SESSIONS)
  })

  it('spawns a PTY without post-Node-18 array copy methods', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toReversed')
    Reflect.deleteProperty(Array.prototype, 'toReversed')
    try {
      await expect(dispatcher.callRequest('pty.spawn', {})).resolves.toMatchObject({
        id: testPtyId(1)
      })
      expect(handler.activePtyCount).toBe(1)
    } finally {
      if (descriptor) {
        Object.defineProperty(Array.prototype, 'toReversed', descriptor)
      }
    }
  })

  it('increments PTY ids on each spawn', async () => {
    const r1 = await dispatcher.callRequest('pty.spawn', {})
    const r2 = await dispatcher.callRequest('pty.spawn', {})
    expect((r1 as { id: string }).id).toBe(testPtyId(1))
    expect((r2 as { id: string }).id).toBe(testPtyId(2))
  })

  it('does not remint a PTY id across handler lifetimes', async () => {
    const first = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    await handler.dispose({ waitForPhysicalExit: false })
    dispatcher = createMockDispatcher()
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)

    const second = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }

    expect(first.id).toMatch(/^pty2:[^:]+:1$/)
    expect(second.id).toMatch(/^pty2:[^:]+:1$/)
    expect(second.id).not.toBe(first.id)
  })

  it('escapes the mint epoch so it cannot forge the id separators', async () => {
    await handler.dispose({ waitForPhysicalExit: false })
    dispatcher = createMockDispatcher()
    // Why: the epoch is constructor-supplied. Encoding is what keeps a minted id
    // exactly three fields, so it can never be read as another epoch/sequence and
    // can never smuggle the `@@` that app-side SSH id routing splits on.
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher, undefined, 'a:b@@c:9')

    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }

    const [prefix, epoch, sequence, ...extra] = spawned.id.split(':')
    expect(extra).toEqual([])
    expect(prefix).toBe('pty2')
    expect(decodeURIComponent(epoch)).toBe('a:b@@c:9')
    expect(sequence).toBe('1')
    expect(spawned.id).not.toContain('@@')
  })

  it('revives a legacy id and advances the legacy sequence', async () => {
    const state = JSON.stringify([
      { id: 'pty-7', pid: process.pid, cols: 80, rows: 24, cwd: process.cwd() }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const serialized = (await dispatcher.callRequest('pty.serialize', {
      ids: ['pty-7']
    })) as string
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }

    expect(JSON.parse(serialized)).toMatchObject([{ id: 'pty-7' }])
    expect(spawned.id).toBe(testPtyId(8))
  })

  it('does not advance its sequence from a revived foreign mint epoch', async () => {
    const foreignId = 'pty2:previous-mint-epoch:40'
    const state = JSON.stringify([
      { id: foreignId, pid: process.pid, cols: 80, rows: 24, cwd: process.cwd() }
    ])
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await dispatcher.callRequest('pty.revive', { state })
    } finally {
      killSpy.mockRestore()
    }

    const serialized = (await dispatcher.callRequest('pty.serialize', {
      ids: [foreignId]
    })) as string
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }

    expect(JSON.parse(serialized)).toMatchObject([{ id: foreignId }])
    expect(spawned.id).toBe(testPtyId(1))
  })

  it('admits default-cwd spawns through the worktree removal coordinator', async () => {
    const finishCreation = vi.fn()
    const beginWorktreePtySpawn = vi.fn((_operationPath: string) => finishCreation)
    handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })

    await dispatcher.callRequest('pty.spawn', {})

    expect(beginWorktreePtySpawn).toHaveBeenCalledWith(expect.any(String))
    expect(beginWorktreePtySpawn.mock.calls[0][0]).not.toBe('')
    expect(finishCreation).toHaveBeenCalledTimes(1)
  })

  // requireRelaySpawnCwd strips the `::workspace:<uuid>` instance suffix to get the real folder
  // path, so a fence keyed on the unstripped id would guard a directory no spawn ever uses --
  // exactly what routing both through one resolver is supposed to make impossible.
  it('fences a folder-workspace instance id on the directory the spawn will use', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'orca-relay-fence-'))
    try {
      const finishCreation = vi.fn()
      const beginWorktreePtySpawn = vi.fn((_operationPath: string) => finishCreation)
      handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })

      await dispatcher.callRequest('pty.spawn', {
        worktreeId: `repo-1::${workspaceRoot}::workspace:b1706d92-9d05-4932-8360-01e00b54305a`
      })

      const fencedPaths = beginWorktreePtySpawn.mock.calls.map((call) => call[0])
      expect(fencedPaths).toContain(workspaceRoot)
      expect(fencedPaths.some((fenced) => fenced.includes('::workspace:'))).toBe(false)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('fences both sibling worktree identity and removing cwd with rollback', async () => {
    const finishSiblingAdmission = vi.fn()
    const beginWorktreePtySpawn = vi.fn((operationPath: string) => {
      if (operationPath === '/repo/removing/nested') {
        throw new Error('Remote worktree deletion already in progress')
      }
      return finishSiblingAdmission
    })
    handler.setWorktreeRemovalCoordinator({ beginWorktreePtySpawn })

    await expect(
      dispatcher.callRequest('pty.spawn', {
        cwd: '/repo/removing/nested',
        env: { ORCA_WORKTREE_ID: 'repo-id::/repo/sibling' }
      })
    ).rejects.toThrow('Remote worktree deletion already in progress')

    expect(beginWorktreePtySpawn.mock.calls.map(([operationPath]) => operationPath)).toEqual([
      '/repo/sibling',
      '/repo/removing/nested'
    ])
    expect(finishSiblingAdmission).toHaveBeenCalledOnce()
    expect(mockPtySpawn).not.toHaveBeenCalled()
  })

  describe('onPtyPoolEmpty', () => {
    it('fires once when natural exit drains the last PTY, never while one remains', async () => {
      const onExitCallbacks: ((evt: { exitCode: number }) => void)[] = []
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        onData: vi.fn(),
        onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
          onExitCallbacks.push(cb)
        })
      })
      const poolEmpty = vi.fn()
      handler.onPtyPoolEmpty(poolEmpty)

      await spawnPty()
      await spawnPty()
      expect(onExitCallbacks).toHaveLength(2)

      onExitCallbacks[0]({ exitCode: 0 })
      expect(handler.activePtyCount).toBe(1)
      expect(poolEmpty).not.toHaveBeenCalled()

      onExitCallbacks[1]({ exitCode: 0 })
      expect(handler.activePtyCount).toBe(0)
      expect(poolEmpty).toHaveBeenCalledTimes(1)
    })

    it('fires when the dead-shell reap inside attach removes the last PTY', async () => {
      mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
      const poolEmpty = vi.fn()
      handler.onPtyPoolEmpty(poolEmpty)
      await spawnPty()

      const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)
      try {
        await expect(
          attachPty({ id: testPtyId(1), suppressReplayNotification: true })
        ).rejects.toThrow(`PTY "${testPtyId(1)}" not found`)
      } finally {
        aliveSpy.mockRestore()
      }

      expect(handler.activePtyCount).toBe(0)
      expect(poolEmpty).toHaveBeenCalledTimes(1)
    })

    it('fires when dispose-for-shutdown removes the last PTY', async () => {
      mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
      const poolEmpty = vi.fn()
      handler.onPtyPoolEmpty(poolEmpty)
      await spawnPty()
      await spawnPty()

      await handler.dispose({ waitForPhysicalExit: false })

      expect(handler.activePtyCount).toBe(0)
      expect(poolEmpty).toHaveBeenCalledTimes(1)
    })

    it('fires when a spawn fails before the PTY ever reaches the pool', async () => {
      // Why: removePty can only announce a PTY it stored, so a creation that dies mid-flight
      // would otherwise leave the relay believing it is still non-idle forever.
      mockPtySpawn.mockImplementation(() => {
        throw new Error('posix_spawnp failed')
      })
      const poolEmpty = vi.fn()
      handler.onPtyPoolEmpty(poolEmpty)

      await expect(spawnPty()).rejects.toThrow()

      expect(handler.activePtyCount).toBe(0)
      expect(handler.pendingPtyCreationCount).toBe(0)
      expect(poolEmpty).toHaveBeenCalledTimes(1)
    })

    it('stays silent when a failing creation settles while another is still admitted', async () => {
      let spawnCall = 0
      mockPtySpawn.mockImplementation(() => {
        spawnCall += 1
        if (spawnCall === 1) {
          throw new Error('posix_spawnp failed')
        }
        return { ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() }
      })
      const poolEmpty = vi.fn()
      handler.onPtyPoolEmpty(poolEmpty)

      // Both admissions land before either creation resolves, so the failing one must not
      // announce an empty pool while the surviving one still owns a shell.
      const failing = spawnPty()
      const succeeding = spawnPty()
      expect(handler.pendingPtyCreationCount).toBe(2)

      await expect(failing).rejects.toThrow()
      await succeeding

      expect(handler.activePtyCount).toBe(1)
      expect(poolEmpty).not.toHaveBeenCalled()
    })

    it('stops notifying after the returned unsubscribe runs', async () => {
      const onExitCallbacks: ((evt: { exitCode: number }) => void)[] = []
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        onData: vi.fn(),
        onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
          onExitCallbacks.push(cb)
        })
      })
      const poolEmpty = vi.fn()
      const unsubscribe = handler.onPtyPoolEmpty(poolEmpty)

      await spawnPty()
      onExitCallbacks[0]({ exitCode: 0 })
      expect(poolEmpty).toHaveBeenCalledTimes(1)

      unsubscribe()
      await spawnPty()
      onExitCallbacks[1]({ exitCode: 0 })
      expect(handler.activePtyCount).toBe(0)
      expect(poolEmpty).toHaveBeenCalledTimes(1)
    })
  })

  describe('onPtyPoolActive', () => {
    it('fires at admission, while the pool is still empty', async () => {
      mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
      const poolCounts: number[] = []
      handler.onPtyPoolActive(() => {
        poolCounts.push(handler.activePtyCount)
      })

      const pending = spawnPty()
      // The relay must learn it is non-idle here, not after the creation resolves.
      expect(poolCounts).toEqual([0])

      await pending
      expect(poolCounts).toEqual([0, 1])
    })

    it('fires for a revived PTY whose creation was admitted before the pool was empty', async () => {
      await spawnPty({ cols: 80, rows: 24, cwd: '/tmp' })
      const state = (await dispatcher.callRequest('pty.serialize', {
        ids: [testPtyId(1)]
      })) as string
      await handler.dispose({ waitForPhysicalExit: false })
      dispatcher = createMockDispatcher()
      handler = createTestPtyHandler(dispatcher)
      mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
      const poolActive = vi.fn()
      handler.onPtyPoolActive(poolActive)

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        await dispatcher.callRequest('pty.revive', { state })
      } finally {
        killSpy.mockRestore()
      }

      expect(handler.activePtyCount).toBe(1)
      expect(poolActive).toHaveBeenCalled()
    })

    it('stops notifying after the returned unsubscribe runs', async () => {
      mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
      const poolActive = vi.fn()
      const unsubscribe = handler.onPtyPoolActive(poolActive)

      await spawnPty()
      const callsWhileSubscribed = poolActive.mock.calls.length
      expect(callsWhileSubscribed).toBeGreaterThan(0)

      unsubscribe()
      await spawnPty()
      expect(poolActive).toHaveBeenCalledTimes(callsWhileSubscribed)
    })
  })

  it('counts a spawn admitted but not yet pooled as a pending creation', async () => {
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, onData: vi.fn(), onExit: vi.fn() })
    expect(handler.pendingPtyCreationCount).toBe(0)

    const pending = spawnPty()
    // The shell is already owned even though activePtyCount still reads zero.
    expect(handler.activePtyCount).toBe(0)
    expect(handler.pendingPtyCreationCount).toBe(1)

    await pending
    expect(handler.activePtyCount).toBe(1)
    expect(handler.pendingPtyCreationCount).toBe(0)
  })
})
