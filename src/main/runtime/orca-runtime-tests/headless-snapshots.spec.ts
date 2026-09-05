import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, setPlatform } from '../orca-runtime-test-mocks.spec'
import type { HeadlessEmulator } from '../../daemon/headless-emulator'
import type { RuntimeTerminalAgentStatusEvent } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  createRuntime,
  makeDeferred,
  makeStatusFrame,
  parseHeadlessSnapshotLines,
  referenceStatusFrameLines,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('returns OSC titles from headless main terminal snapshots', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07hello\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      lastTitle: 'Codex working'
    })
  })

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
    // The real renderer serializer emits the normal buffer first and the `?1049h`
    // alt frame after it; asking it to zero the scrollback while a TUI is up drops
    // the shell history, not the TUI bytes. Model that contract here.
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

  it('adopts renderer-seeded titles into headless main terminal snapshots', async () => {
    const artifactPath = '/tmp/renderer-seeded-artifact.json'
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: `renderer scrollback\nwrote ${artifactPath}\n`,
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer seeded Codex'
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 100, rows: 30 })
    })
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals

    runtime.onPtyData('pty-1', 'live output without title\n', 100)

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      lastTitle: 'Renderer seeded Codex'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: expect.any(Number)
    })
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('returns cwd metadata from seeded headless main terminal snapshots', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/restored-scrollback-artifact.json'

    runtime.seedHeadlessTerminal(
      'pty-1',
      `restored scrollback\nwrote ${artifactPath}\n`,
      { cols: 100, rows: 30 },
      {
        cwd: '/projects/restored'
      }
    )

    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    expect(snapshot).toMatchObject({
      source: 'headless',
      cwd: '/projects/restored'
    })
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('resolves paths without candidate activation via the lazy safety net', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/lazy-activation-artifact.json'

    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)

    // No mobile connect ever happened; the query itself must activate+backfill.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('backfills candidates on activation so scrolled-off paths still resolve', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/backfilled-artifact.json'

    // Path arrives while tracking is inactive (desktop-only phase).
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)
    // First mobile connect: backfill from the retained raw window.
    runtime.activateRecentPtyPathCandidateTracking()
    // Scroll the raw 64KB window past the path with pathless output.
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Only the backfilled candidate tier can answer now.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('backfills per retained chunk so chunk boundaries match the eager extractor', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/a.json'

    // Two chunks whose join would parse as one different candidate
    // (/tmp/a.jsonsuffix.txt). The eager per-chunk extractor kept /tmp/a.json.
    runtime.onPtyData('pty-1', `wrote ${artifactPath}`, 100)
    runtime.onPtyData('pty-1', 'suffix.txt', 150)
    runtime.activateRecentPtyPathCandidateTracking()
    // Scroll the raw 64KB window so only the backfilled candidates can answer.
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('extracts candidates per chunk after activation for scrolled-off paths', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/post-activation-artifact.json'

    runtime.activateRecentPtyPathCandidateTracking()
    // Idempotent: a second activation must not disturb live tracking.
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('does not retain pre-activation paths that scrolled past the raw window', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/pre-activation-scrolled-artifact.json'

    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n`, 100)
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Documented accepted loss: output that scrolled past the raw window
    // before the first-ever mobile connect yields no candidates.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      false
    )
  })

  it('backfill does not mint candidates from an over-limit line shortened by the window trim', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/result.json'

    // One chunk with a >4KiB line whose tail is the path: the eager
    // extractor skipped it under the line-length guard.
    runtime.onPtyData('pty-1', `${'a'.repeat(5000)} ${artifactPath}\n`, 100)
    // Newline-free filler trims the window to ~1KiB before the path, so a
    // trimmed-head replay would see an under-limit line ending in the path.
    runtime.onPtyData('pty-1', 'y'.repeat(64 * 1024 - 1000), 150)
    runtime.activateRecentPtyPathCandidateTracking()
    // Scroll the raw window so only backfilled candidates can answer.
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Parity with eager extraction: the over-limit line never yielded a
    // candidate, so the grant must stay denied after the raw window scrolls.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      false
    )
  })

  it('backfill replays the full head chunk including its window-trimmed prefix', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/trimmed-prefix-artifact.json'

    // Path sits in the head chunk's prefix, which the window trim drops from
    // read() but the eager extractor saw at append time.
    runtime.onPtyData('pty-1', `wrote ${artifactPath}\n${'b'.repeat(3000)}\n`, 100)
    runtime.onPtyData('pty-1', 'y'.repeat(64 * 1024 - 1000), 150)
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    // Parity with eager extraction: the append-time candidate outlived the
    // raw window, so backfill must recover it from the intact head chunk.
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('matches eager extraction exactly for a pre-sliced oversized chunk', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const cutLinePath = '/tmp/cut-line.json'
    const keptPath = '/tmp/kept-after-cut.json'

    // Single >64KiB append is stored pre-sliced, so its original text is
    // unrecoverable at activation time. Extraction runs eagerly at append
    // instead: cutLinePath sat on an over-4KiB line the extractor's line
    // guard rejects (and the slice leaves an under-4KiB tail of it that must
    // NOT mint a candidate later), while keptPath sat on a short line and
    // must survive the raw window scrolling.
    const keptLine = `wrote ${keptPath}\n`
    const afterFirstLine = `${keptLine}${'z'.repeat(62 * 1024 - keptLine.length)}`
    const oversized = `${'a'.repeat(5 * 1024)} ${cutLinePath}\n${afterFirstLine}`
    runtime.onPtyData('pty-1', oversized, 100)
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, cutLinePath, cutLinePath)).toBe(
      false
    )
    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, keptPath, keptPath)).toBe(true)
  })

  it('keeps a candidate from the short first line of an oversized chunk after the window scrolls', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals
    const artifactPath = '/tmp/result.json'

    // A short first line of a >64KiB chunk loses only its `wrote ` prefix to
    // the pre-slice; the path itself stays in the retained window. The old
    // eager extractor recorded it from the intact original chunk, so it must
    // stay authorized after the raw window scrolls — parity requires the
    // append-time extraction for oversized chunks, not backfill replay.
    const firstLine = `wrote ${artifactPath}\n`
    runtime.onPtyData('pty-1', `${firstLine}${'f'.repeat(64 * 1024 + 6 - firstLine.length)}`, 100)
    runtime.activateRecentPtyPathCandidateTracking()
    runtime.onPtyData('pty-1', 'x'.repeat(70 * 1024), 200)

    expect(runtime.hasRecentTerminalOutputPath(terminal.handle, artifactPath, artifactPath)).toBe(
      true
    )
  })

  it('replaces suffix-only headless state with the recovered renderer snapshot', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    runtime.seedHeadlessTerminal('pty-1', 'suffix-only redraw', { cols: 80, rows: 24 })

    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery('pty-1', {
      data: 'restored history\r\nprompt $ ',
      cols: 80,
      rows: 24,
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
  })

  it('adopts OSC7 host metadata from seeded headless terminal scrollback', async () => {
    const runtime = createRuntime()
    syncSinglePty(runtime, 'pty-1')
    const [terminal] = (await runtime.listTerminals()).terminals

    runtime.seedHeadlessTerminal(
      'pty-1',
      '\x1b]7;file://remote-host/tmp\x07restored scrollback\n',
      { cols: 100, rows: 30 }
    )

    expect(runtime.resolveTerminalFileUriHostname(terminal.handle)).toBe('remote-host')
  })

  it('falls back to the renderer snapshot for hidden-output recovery without headless state', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: '\x1b[?1049hRenderer TUI\r\nStill running\r\n',
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer working'
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true
    })
    syncSinglePty(runtime, 'pty-1')

    const snapshot = await runtime.serializeHiddenOutputRecoveryBuffer('pty-1', {
      scrollbackRows: 5000
    })

    expect(snapshot).toEqual({
      data: '\x1b[?1049hRenderer TUI\r\nStill running\r\n',
      cols: 100,
      rows: 30,
      lastTitle: 'Renderer working',
      source: 'renderer'
    })
    expect(serializeBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000
    })
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
    // Why alternateScreen stays true here: the mirror never rewrites its own
    // model — without a daemon barrier injecting the reset in-stream (direct
    // provider path), the snapshot publishes the poisoned mode alongside the
    // proof and the renderer's dead-TUI branch grounds the pane.
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

  it('keeps an empty headless snapshot authoritative for hidden-output recovery', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'stale renderer content\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true
    })
    type HeadlessStateForTest = {
      emulator: {
        isAlternateScreen: boolean
        getSnapshot: (opts: { scrollbackRows?: number }) => {
          rehydrateSequences: string
          snapshotAnsi: string
          cols: number
          rows: number
        }
      }
      outputSequence: number
      writeChain: Promise<void>
      ownership: { settle: () => Promise<void>; owner: undefined }
    }
    const runtimePrivate = runtime as unknown as {
      headlessTerminals: Map<string, HeadlessStateForTest>
    }
    runtimePrivate.headlessTerminals.set('pty-empty', {
      emulator: {
        isAlternateScreen: false,
        getSnapshot: () => ({ rehydrateSequences: '', snapshotAnsi: '', cols: 90, rows: 30 })
      },
      outputSequence: 17,
      writeChain: Promise.resolve(),
      ownership: { settle: async () => {}, owner: undefined }
    })

    await expect(runtime.serializeHiddenOutputRecoveryBuffer('pty-empty')).resolves.toEqual({
      data: '',
      cols: 90,
      rows: 30,
      seq: 17,
      source: 'headless',
      // Non-alt-screen reports alternateScreen=false so the renderer keeps its destructive scrollback clear on restore.
      alternateScreen: false
    })
    expect(serializeBuffer).not.toHaveBeenCalled()
  })

  it('advances the absolute output sequence across a daemon stream gap', () => {
    const runtime = createRuntime()
    runtime.onPtyData('pty-gap', 'before', Date.now())

    runtime.notePtyDataGap('pty-gap', 4096)
    runtime.onPtyData('pty-gap', 'after', Date.now())

    expect(runtime.getPtyOutputSequence('pty-gap')).toBe('before'.length + 4096 + 'after'.length)
  })

  it('emits explicit OSC 9999 agent status from runtime PTY data', () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab-1:${leafId}`
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
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData(
      'pty-1',
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after',
      123
    )

    expect(statuses).toEqual([
      {
        ptyId: 'pty-1',
        source: 'mounted-leaf',
        paneKey,
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'codex'
        }
      }
    ])
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
