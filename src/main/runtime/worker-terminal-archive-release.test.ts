import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARCHIVE_SCREEN_LINES,
  createTerminalArchiveFixture
} from './worker-terminal-archive.test-support'
import { createOrchestrationWorkerReleaseHarness } from './rpc/methods/orchestration/worker/worker-release.test-support'

function dispatchIdOf(receipt: unknown): string {
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    !('dispatchId' in receipt) ||
    typeof receipt.dispatchId !== 'string'
  ) {
    throw new Error('No dispatch in worker-start receipt')
  }
  return receipt.dispatchId
}

describe('released worker archives preserve the host screen', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  function prepareFailedStart() {
    h.setup()
    const retryPane = 'tab_retry:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    vi.mocked(h.runtime.createTerminal)
      .mockResolvedValueOnce({
        handle: 'term_worker',
        worktreeId: 'repo::worktree',
        title: 'worker'
      })
      .mockResolvedValue({ handle: 'term_retry', worktreeId: 'repo::worktree', title: 'retry' })
    vi.mocked(h.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_retry'
        ? retryPane
        : handle === 'term_coord'
          ? h.coordinatorPaneKey
          : h.workerPaneKey
    )
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation(
      (handle) => `runtime_test:${handle}:1`
    )
    vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) => ({
      runtimeId: 'runtime_test',
      terminalHandle: handle,
      ptyId: `pty_${handle}`,
      worktreeId: 'repo::worktree',
      paneKey: handle === 'term_retry' ? retryPane : h.workerPaneKey,
      processIncarnation: `runtime_test:${handle}:1`,
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    }))
    vi.mocked(h.runtime.waitForTerminal).mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'agent-interactive-prompt'
    })
    return h.db.createTask({ spec: 'startup diagnostic', runId: h.activeRunId })
  }

  it.each([
    { route: 'automatic retry', provider: false, stream: '\r\n'.repeat(7) },
    { route: 'automatic retry', provider: false, stream: `host % codex\r\n${'\r\n'.repeat(6)}` },
    { route: 'manual release', provider: false, stream: '\r\n'.repeat(7) },
    { route: 'manual release', provider: false, stream: `host % codex\r\n${'\r\n'.repeat(6)}` },
    { route: 'automatic retry', provider: true, stream: '\r\n'.repeat(7) },
    { route: 'automatic retry', provider: true, stream: `host % codex\r\n${'\r\n'.repeat(6)}` },
    { route: 'manual release', provider: true, stream: '\r\n'.repeat(7) },
    { route: 'manual release', provider: true, stream: `host % codex\r\n${'\r\n'.repeat(6)}` }
  ])('freezes the full diagnostic before $route (%j)', async ({ route, provider, stream }) => {
    const task = prepareFailedStart()
    const fixture = await createTerminalArchiveFixture({ provider })
    fixture.runtime.onPtyData('pty-1', stream, Date.now())
    const failed = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    const dispatchId = dispatchIdOf(failed)
    vi.mocked(h.runtime.readTerminal).mockImplementation((_handle, opts) =>
      fixture.runtime.readTerminal(fixture.handle, opts)
    )
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      const archive = h.db.getWorkerTerminalArchive(dispatchId)
      expect(archive?.content).toContain(ARCHIVE_SCREEN_LINES[1])
      fixture.runtime.onPtyExit('pty-1', 0)
      return { handle, tabId: 'tab-worker', ptyKilled: true }
    })

    if (route === 'automatic retry') {
      await expect(
        h.call('orchestration.workerStart', {
          task: task.id,
          retryOf: dispatchId,
          from: 'term_coord',
          agent: 'codex'
        })
      ).resolves.toMatchObject({ state: 'failed' })
      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
    } else {
      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
    }

    expect(h.runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_worker')
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.archive_status).toBe('captured')
    vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live output is gone'))
    const read = await h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
    expect(read).toMatchObject({
      archived: true,
      source: 'terminal',
      sourceExact: false,
      contentComplete: false,
      terminal: { tail: expect.arrayContaining(ARCHIVE_SCREEN_LINES), nextCursor: null }
    })
    if (stream.includes('host % codex')) {
      expect(read).toMatchObject({ terminal: { tail: expect.arrayContaining(['host % codex']) } })
    }
  })

  it.each([
    { cols: 100, prefix: 89, provider: false },
    { cols: 100, prefix: 97, provider: false },
    { cols: 10, prefix: 7, provider: false },
    { cols: 3, prefix: 0, provider: false },
    { cols: 100, prefix: 89, provider: true },
    { cols: 10, prefix: 7, provider: true }
  ])(
    'masks wrapped tokens in stored and post-close output (%j)',
    async ({ cols, prefix, provider }) => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('failed')
      const secret = `dcap_${'s'.repeat(24)}`
      const text = `${'x'.repeat(prefix)} ${secret}`
      const fixture = await createTerminalArchiveFixture({
        hydrate: false,
        cols,
        provider,
        screenLines: [text, 'Safe diagnostic']
      })
      fixture.runtime.onPtyData(
        'pty-1',
        provider ? 'retained history\r\n' : `${text}\r\nSafe diagnostic\r\n`,
        Date.now()
      )
      const screen = await fixture.runtime.readTerminal(fixture.handle, { screen: true })
      expect(screen.tail.join('')).toContain(secret)
      expect(screen.tail).not.toContain(secret)
      vi.mocked(h.runtime.readTerminal).mockImplementation((_handle, opts) =>
        fixture.runtime.readTerminal(fixture.handle, opts)
      )
      vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
        fixture.runtime.onPtyExit('pty-1', 0)
        return { handle, tabId: 'tab-worker', ptyKilled: true }
      })

      await expect(
        h.call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
      const stored = h.db.getWorkerTerminalArchive(dispatchId)
      if (!stored) {
        throw new Error('No stored archive')
      }
      expect(stored.content).not.toContain(secret)
      const content: unknown = JSON.parse(stored.content)
      if (
        typeof content !== 'object' ||
        content === null ||
        !('lines' in content) ||
        !Array.isArray(content.lines)
      ) {
        throw new Error('No stored terminal lines')
      }
      expect(content.lines.join('')).not.toContain(secret)
      expect(content.lines.join('')).toContain('Safe diagnostic')
      vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live output gone'))
      const read = await h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
      expect(read).toMatchObject({
        archived: true,
        terminal: { nextCursor: null },
        warnings: expect.arrayContaining([
          'Dispatch capability tokens were redacted from terminal output.'
        ])
      })
      if (
        typeof read !== 'object' ||
        read === null ||
        !('terminal' in read) ||
        typeof read.terminal !== 'object' ||
        read.terminal === null ||
        !('tail' in read.terminal) ||
        !Array.isArray(read.terminal.tail)
      ) {
        throw new Error('No archived terminal output')
      }
      expect(read.terminal.tail.join('')).not.toContain(secret)
      expect(read.terminal.tail.join('')).toContain('Safe diagnostic')
    }
  )

  it.each(['soft wrap', 'multiple lines'] as const)(
    'masks a real composer draft after release (%s)',
    async (layout) => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('failed')
      const fixture = await createTerminalArchiveFixture({ hydrate: false })
      const secret = `dcap_${'s'.repeat(24)}`
      const composer =
        layout === 'soft wrap'
          ? `❯ ${'x'.repeat(89)} ${secret}\x1b[1A\x1b[3G`
          : `❯ dc\r\n  ap_sssss\r\n  ${'s'.repeat(19)}\x1b[2A\x1b[3G`
      fixture.runtime.onPtyData('pty-1', `Safe diagnostic\r\n────────\r\n${composer}`, Date.now())
      const screen = await fixture.runtime.readTerminal(fixture.handle, { screen: true })
      expect(screen.draft?.replaceAll('\n', '')).toContain(secret)
      vi.mocked(h.runtime.readTerminal).mockImplementation((_handle, opts) =>
        fixture.runtime.readTerminal(fixture.handle, opts)
      )
      vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
        fixture.runtime.onPtyExit('pty-1', 0)
        return { handle, tabId: 'tab-worker', ptyKilled: true }
      })
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
      expect(h.db.getWorkerTerminalArchive(dispatchId)?.content).not.toContain(secret)
      vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live output gone'))
      const read = await h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
      expect(read).toMatchObject({
        archived: true,
        terminal: {
          nextCursor: null,
          draft:
            layout === 'soft wrap'
              ? expect.stringContaining('[dispatch capability redacted]')
              : screen.draft
        }
      })
      if (
        typeof read !== 'object' ||
        read === null ||
        !('terminal' in read) ||
        typeof read.terminal !== 'object' ||
        read.terminal === null ||
        !('draft' in read.terminal) ||
        typeof read.terminal.draft !== 'string'
      ) {
        throw new Error('No archived draft')
      }
      if (layout === 'soft wrap') {
        expect(read.terminal.draft.replaceAll('\n', '')).not.toContain(secret)
      } else {
        expect(read.terminal.draft).toBe(screen.draft)
      }
    }
  )

  it.each(['takeover', 'identity change'] as const)(
    'keeps the pane when %s wins during the screen capture',
    async (race) => {
      const task = prepareFailedStart()
      const fixture = await createTerminalArchiveFixture()
      fixture.runtime.onPtyData('pty-1', '\r\n'.repeat(7), Date.now())
      const failed = await h.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        agent: 'codex'
      })
      const dispatchId = dispatchIdOf(failed)
      const pending = h.deferred<void>()
      let screenStarted = false
      vi.mocked(h.runtime.readTerminal).mockImplementation(async (_handle, opts) => {
        if (opts?.screen) {
          screenStarted = true
          await pending.promise
        }
        return fixture.runtime.readTerminal(fixture.handle, opts)
      })
      const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
      await vi.waitFor(() => expect(screenStarted).toBe(true))
      if (race === 'takeover') {
        await h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })
      } else {
        vi.mocked(h.runtime.getTerminalProcessIncarnation).mockReturnValue(
          'runtime_test:term_worker:2'
        )
        vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockReturnValue({
          runtimeId: 'runtime_test',
          terminalHandle: 'term_worker',
          ptyId: 'pty_term_worker',
          worktreeId: 'repo::worktree',
          paneKey: h.workerPaneKey,
          processIncarnation: 'runtime_test:term_worker:2',
          launchTokenHash: null,
          hostScope: { kind: 'local', hostId: 'local' }
        })
      }
      pending.resolve()
      await expect(release).resolves.toMatchObject({ state: 'retained' })
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      if (race === 'takeover') {
        expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
      } else {
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.retained_reason).toBe(
          'identity_unproven'
        )
      }
    }
  )
})
