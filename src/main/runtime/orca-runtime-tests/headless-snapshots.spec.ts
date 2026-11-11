import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { setPlatform } from '../orca-runtime-test-mocks/setup.spec'
import type { RuntimeTerminalAgentStatusEvent } from '../terminal/output/terminal-agent-status-events'
import type { HeadlessEmulator } from '../../daemon/emulation/headless-emulator'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  declarePendingPaneSerializer,
  settlePendingPaneSerializer
} from '../../ipc/pty/pane/serializer-state'
import { seedHeadlessTerminalFromSpawnResult } from '../../ipc/pty/pane/terminal-spawn-restore'

import {
  TEST_WORKTREE_ID,
  createRuntime,
  makeDeferred,
  makeStatusFrame,
  parseHeadlessSnapshotLines,
  referenceStatusFrameLines,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('resizes the headless mirror after an accepted desktop PTY resize', async () => {
    const spawn = { cols: 80, rows: 24 }
    const resized = { cols: 120, rows: 30 }
    let currentSize = spawn
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => currentSize
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', 'user@host % claude\r\n', 100)
    currentSize = resized
    runtime.onExternalPtyResize('pty-1', resized.cols, resized.rows)
    for (let index = 0; index < 5; index += 1) {
      runtime.onPtyData('pty-1', makeStatusFrame(index, index === 0), 200 + index)
    }

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 5000 })
    expect(snapshot).toMatchObject({ cols: resized.cols, rows: resized.rows, source: 'headless' })
    await expect(parseHeadlessSnapshotLines(snapshot!, resized)).resolves.toEqual(
      await referenceStatusFrameLines(spawn, resized)
    )
  })

  it('orders headless mirror resizes behind queued PTY writes', async () => {
    const spawn = { cols: 80, rows: 10 }
    const resized = { cols: 120, rows: 10 }
    let currentSize = spawn
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => currentSize,
      resize: () => {
        currentSize = resized
        return true
      }
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.onPtyData('pty-1', 'prompt\r\n', 100)
    await runtime.serializeMainTerminalBuffer('pty-1')

    type HeadlessStateForTest = {
      emulator: HeadlessEmulator
      writeChain: Promise<void>
    }
    const headless = (
      runtime as unknown as { headlessTerminals: Map<string, HeadlessStateForTest> }
    ).headlessTerminals.get('pty-1')
    expect(headless).toBeDefined()
    const originalWrite = headless!.emulator.write.bind(headless!.emulator)
    const queuedWriteStarted = makeDeferred()
    const releaseQueuedWrite = makeDeferred()
    headless!.emulator.write = async (data: string): Promise<void> => {
      queuedWriteStarted.resolve()
      await releaseQueuedWrite.promise
      await originalWrite(data)
    }

    try {
      runtime.onPtyData('pty-1', '\x1b[90GOLD', 200)
      await queuedWriteStarted.promise
      await runtime.updateDesktopViewport('pty-1', resized)
      runtime.onPtyData('pty-1', '\r\nNEXT', 300)
      releaseQueuedWrite.resolve()

      const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 100 })
      expect(snapshot).toMatchObject({ cols: resized.cols, rows: resized.rows })
      await expect(parseHeadlessSnapshotLines(snapshot!, resized)).resolves.toEqual([
        'prompt',
        '                                                                               O',
        'LD',
        'NEXT'
      ])
    } finally {
      headless!.emulator.write = originalWrite
      releaseQueuedWrite.resolve()
    }
  })

  it('keeps pre-TUI shell scrollback when hydrating from a renderer on the alternate screen (#6106)', async () => {
    // Renderer serialization emits normal scrollback before alt-screen bytes; zeroing scrollback loses shell history.
    const serializeBuffer = vi.fn(async (_ptyId: string, opts?: { scrollbackRows?: number }) => {
      const suppressesScrollback =
        (opts as Record<string, unknown> | undefined)?.altScreenForcesZeroRows === true
      const scrollback = suppressesScrollback ? '' : 'PRE_CODEX_START\r\nAGENTS.md\r\n'
      return {
        data: `${scrollback}\x1b[?1049h\x1b[HCodex TUI frame`,
        cols: 80,
        rows: 24
      }
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', 'live byte', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    const restored = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
    expect(restored).toContain('PRE_CODEX_START')
    expect(restored).toContain('AGENTS.md')
  })

  it('replaces suffix-only headless state with the recovered renderer snapshot', async () => {
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 47, rows: 40 })
    })
    syncSinglePty(runtime, 'pty-1')
    runtime.seedHeadlessTerminal('pty-1', 'suffix-only redraw', { cols: 47, rows: 40 })

    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery('pty-1', {
      data: 'restored history\r\nprompt $ ',
      cols: 200,
      rows: 50,
      cwd: '/projects/restored'
    })
    runtime.onPtyData('pty-1', 'after recovery\r\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', {
      scrollbackRows: 100
    })
    expect(snapshot?.data).toContain('restored history')
    expect(snapshot?.data).toContain('after recovery')
    expect(snapshot?.data).not.toContain('suffix-only redraw')
    expect(snapshot?.cwd).toBe('/projects/restored')
    expect({ cols: snapshot?.cols, rows: snapshot?.rows }).toEqual({ cols: 47, rows: 40 })
  })

  it('retains cold-restored history in hidden-output recovery while renderer serialization is pending', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'cold-pty')
    const paneKey = makePaneKey('tab-1', '44444444-4444-4444-8444-444444444444')
    const generation = declarePendingPaneSerializer(paneKey, undefined)
    try {
      seedHeadlessTerminalFromSpawnResult(
        runtime,
        {
          id: 'cold-pty',
          coldRestore: { scrollback: 'restored history\r\n', cwd: '/tmp', cols: 40, rows: 6 }
        },
        paneKey
      )
      runtime.onPtyData('cold-pty', 'fresh shell prompt $ ', 100)

      const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('cold-pty', {
        scrollbackRows: 100
      })
      expect(snapshot?.data).toContain('restored history')
      expect(snapshot?.data).toContain('fresh shell prompt $ ')
    } finally {
      settlePendingPaneSerializer(paneKey, generation)
    }
  })

  it('binds shell ownership evidence to the headless snapshot sequence', async () => {
    const runtime = createRuntime()
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined
    const confirmShellForeground = vi.fn(
      () => new Promise<boolean>((resolve) => void (resolveConfirmation = resolve))
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      confirmShellForeground
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', '\x1b[?1049hTUI\x1b]133;D;137\x07shell-marker', 100)
    const shellSnapshotPromise = runtime.serializeHiddenOutputRecoveryBuffer('pty-1')
    await vi.waitFor(() => expect(confirmShellForeground).toHaveBeenCalledTimes(1))
    let snapshotSettled = false
    void shellSnapshotPromise.then(() => {
      snapshotSettled = true
    })
    await Promise.resolve()
    expect(snapshotSettled).toBe(false)

    resolveConfirmation?.(true)
    const shellSnapshot = await shellSnapshotPromise
    // Direct providers cannot inject a daemon reset barrier; retain poisoned alt mode with proof for renderer grounding.
    expect(shellSnapshot).toMatchObject({
      alternateScreen: true,
      terminalOwner: 'shell',
      seq: '\x1b[?1049hTUI\x1b]133;D;137\x07shell-marker'.length
    })
    expect(confirmShellForeground).toHaveBeenCalledTimes(1)

    runtime.onPtyData('pty-1', '\x1b]133;C\x07\x1b[?1049hLIVE-TUI', 101)
    const liveSnapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1')

    expect(liveSnapshot?.alternateScreen).toBe(true)
    expect(liveSnapshot?.terminalOwner).toBeUndefined()
  })

  it('stamps SSH connection identity on runtime terminal status', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-ssh'
        }
      ]
    })
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]9999;{"state":"working","agentType":"codex"}\x07', 123)

    expect(statuses).toEqual([
      expect.objectContaining({
        ptyId: 'pty-ssh',
        source: 'mounted-leaf',
        connectionId: 'ssh-conn-1',
        payload: expect.objectContaining({
          state: 'working',
          agentType: 'codex'
        })
      })
    ])
  })

  it('keeps SSH OSC7 cwd POSIX when the desktop runtime is on Windows', async () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-ssh', 'Ubuntu', { resetIncarnation: true })
    runtime.registerPty('pty-ssh', TEST_WORKTREE_ID, 'ssh-conn-1')

    runtime.onPtyData('pty-ssh', '\x1b]7;file://remote-host/home/me/repo/src\x07', 123)

    const internals = runtime as unknown as {
      terminalCwdByPtyId: Map<string, string>
      terminalFileUriHostnameByPtyId: Map<string, string>
      wslDistroByPtyId: Map<string, string>
    }
    expect(internals.terminalCwdByPtyId.get('pty-ssh')).toBe('/home/me/repo/src')
    expect(internals.terminalFileUriHostnameByPtyId.get('pty-ssh')).toBe('remote-host')
    expect(internals.wslDistroByPtyId.has('pty-ssh')).toBe(false)
  })

  it('uses per-incarnation WSL context before registration and across simultaneous distros', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-ubuntu', 'Ubuntu', { resetIncarnation: true })
    runtime.preparePtyExecutionContext('pty-debian', 'Debian', { resetIncarnation: true })
    runtime.registerPty('pty-ubuntu', TEST_WORKTREE_ID)
    runtime.registerPty('pty-debian', TEST_WORKTREE_ID)

    runtime.onPtyData('pty-ubuntu', '\x1b]7;file://DESKTOP/home/me/repo\x07', 1)
    runtime.onPtyData('pty-debian', '\x1b]7;file://DESKTOP/home/me/repo\x07', 1)

    const cwds = (runtime as unknown as { terminalCwdByPtyId: Map<string, string> })
      .terminalCwdByPtyId
    expect(cwds.get('pty-ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    expect(cwds.get('pty-debian')).toBe('\\\\wsl.localhost\\Debian\\home\\me\\repo')
  })

  it('does not retain WSL context when a PTY id is reused', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-reused', 'Ubuntu', { resetIncarnation: true })
    runtime.registerPty('pty-reused', TEST_WORKTREE_ID)
    runtime.onPtyExit('pty-reused', 0)

    runtime.preparePtyExecutionContext('pty-reused', null, { resetIncarnation: true })
    runtime.registerPty('pty-reused', TEST_WORKTREE_ID)
    runtime.onPtyData('pty-reused', '\x1b]7;file://server/share/repo\x07', 1)

    const cwds = (runtime as unknown as { terminalCwdByPtyId: Map<string, string> })
      .terminalCwdByPtyId
    expect(cwds.get('pty-reused')).toBe('\\\\server\\share\\repo')
  })

  it('preserves immutable context while a live daemon attach is unresolved', () => {
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(store)
    runtime.preparePtyExecutionContext('pty-attached', 'Ubuntu', { resetIncarnation: true })
    runtime.registerPty('pty-attached', TEST_WORKTREE_ID)

    const changed = runtime.preparePtyExecutionContext('pty-attached', 'Debian', {
      preserveExisting: true
    })
    runtime.onPtyData('pty-attached', '\x1b]7;file://DESKTOP/home/me/repo\x07', 1)

    const cwd = (
      runtime as unknown as { terminalCwdByPtyId: Map<string, string> }
    ).terminalCwdByPtyId.get('pty-attached')
    expect(changed).toBe(false)
    expect(cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
  })
})
