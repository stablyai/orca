import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalArchiveFixture } from './worker-terminal-archive.test-support'
import { createOrchestrationWorkerReleaseHarness } from './rpc/methods/orchestration/worker/worker-release.test-support'

function readTail(read: unknown): string[] {
  if (
    typeof read !== 'object' ||
    read === null ||
    !('terminal' in read) ||
    typeof read.terminal !== 'object' ||
    read.terminal === null ||
    !('tail' in read.terminal) ||
    !Array.isArray(read.terminal.tail)
  ) {
    throw new Error('No worker terminal output')
  }
  return read.terminal.tail
}

describe('host wrap provenance in worker output', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  it('retains both views when identical raw history and screen rows have different continuity', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('failed')
    const fixture = await createTerminalArchiveFixture({ hydrate: false, cols: 10 })
    const historyLines = ['dcap_abcde', 'fghijklmno', 'pqrstuvwx', 'Safe']
    fixture.runtime.onPtyData('pty-1', `${historyLines.join('\r\n')}\r\n`, Date.now())
    fixture.runtime.onPtyData(
      'pty-1',
      '\x1b[2J\x1b[Hdcap_abcdefghijklmnopqrstuvwx\x1b[4;1HSafe',
      Date.now()
    )
    const history = await fixture.runtime.readTerminal(fixture.handle, { cursor: 0, limit: 2000 })
    const screen = await fixture.runtime.readTerminal(fixture.handle, { screen: true, limit: 2000 })
    expect(history.tail).toEqual(screen.tail)
    expect(screen.tailRows?.some((row) => row.wrapped)).toBe(true)
    vi.mocked(h.runtime.readTerminal).mockImplementation((_handle, opts) =>
      fixture.runtime.readTerminal(fixture.handle, opts)
    )
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      fixture.runtime.onPtyExit('pty-1', 0)
      return { handle, tabId: 'tab-worker', ptyKilled: true }
    })
    await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    expect(h.db.getWorkerTerminalArchive(dispatchId)?.content).toContain(
      '[dispatch capability redacted]'
    )
    vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live gone'))
    const read = await h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
    expect(read).toMatchObject({ archived: true })
    expect(readTail(read)).toEqual([
      ...historyLines,
      '[dispatch capability redacted]',
      '',
      '',
      'Safe'
    ])
  })

  it.each([1, 2, 3, 5, 10, 29, 30, 80, 100])(
    'masks complete soft-wrapped values from provider-only screens at width %i',
    async (cols) => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('failed')
      const secret = 'dcap_abcdefghijklmnopqrstuvwx'
      const fixture = await createTerminalArchiveFixture({
        provider: true,
        alternate: true,
        cols,
        rows: 100,
        screenLines: [
          `界e\u0301 ${'x'.repeat(Math.max(0, cols - 3))} ${secret}`,
          'PermissionDenied'
        ]
      })
      fixture.runtime.onPtyData('pty-1', 'useful history\r\n', Date.now())
      const raw = await fixture.runtime.readTerminal(fixture.handle, { screen: true, limit: 2000 })
      expect(raw.tail.join('')).toContain(secret)
      expect(raw.tailRows).toHaveLength(raw.tail.length)
      vi.mocked(h.runtime.readTerminal).mockImplementation((_handle, opts) =>
        fixture.runtime.readTerminal(fixture.handle, opts)
      )
      const live = await h.call('orchestration.workerRead', {
        dispatch: dispatchId,
        source: 'terminal',
        limit: 2000
      })
      expect(readTail(live)).toHaveLength(raw.tail.length)
      expect(readTail(live).join('')).not.toContain(secret)
      expect(readTail(live).join('')).not.toContain('abcdefghijklmnopqrstuvwx')
      expect(readTail(live).join('')).toContain('PermissionDenied')
      vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
        fixture.runtime.onPtyExit('pty-1', 0)
        return { handle, tabId: 'tab-worker', ptyKilled: true }
      })
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
      const stored = h.db.getWorkerTerminalArchive(dispatchId)
      expect(stored?.content).not.toContain('abcdefghijklmnopqrstuvwx')
      vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live output gone'))
      const read = await h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
      expect(read).toMatchObject({ archived: true, terminal: { nextCursor: null } })
      expect(readTail(read).join('')).not.toContain(secret)
      expect(readTail(read).join('')).not.toContain('abcdefghijklmnopqrstuvwx')
      expect(readTail(read).join('')).toContain('PermissionDenied')
      expect(readTail(read)).toContain('useful history')
    }
  )

  it('preserves a whitespace token boundary removed from raw display rows', async () => {
    const fixture = await createTerminalArchiveFixture({
      provider: true,
      cols: 25,
      screenLines: [`dcap_sssss${' '.repeat(15)}PermissionDenied`, 'Safe diagnostic']
    })
    fixture.runtime.onPtyData('pty-1', 'useful history\r\n', Date.now())
    const raw = await fixture.runtime.readTerminal(fixture.handle, { screen: true })
    expect(raw.tail).toEqual(['dcap_sssss', 'PermissionDenied', 'Safe diagnostic'])
    expect(raw.tailRows?.[1].wrapped).toBe(true)
    expect(raw.tailRows?.[0].trailingSpaces).toBe(15)
    const archive = await fixture.capture()
    expect(archive.content).toMatchObject({
      lines: ['useful history', 'dcap_sssss', 'PermissionDenied', 'Safe diagnostic']
    })
  })

  it.each(['screen' as const, undefined])(
    'retains complete-line semantics and coverage limits without wrap metadata (source=%s)',
    async (source) => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('failed')
      const secret = 'dcap_abcdefghijklmnopqrstuvwx'
      const fixture = await createTerminalArchiveFixture({
        provider: true,
        alternate: true,
        screenLines: [`${'x'.repeat(89)} ${secret}`, 'PermissionDenied']
      })
      fixture.runtime.onPtyData('pty-1', 'useful history\r\n', Date.now())
      vi.mocked(h.runtime.readTerminal).mockImplementation(async (_handle, opts) => {
        const {
          source: _source,
          tailRows: _rows,
          ...read
        } = await fixture.runtime.readTerminal(fixture.handle, opts)
        return { ...read, ...(source ? { source } : {}) }
      })
      const live = await h.call('orchestration.workerRead', {
        dispatch: dispatchId,
        source: 'terminal',
        limit: 2000
      })
      expect(readTail(live).join('')).toContain(secret)
      expect(readTail(live)).toContain('PermissionDenied')
      expect(live).toMatchObject({
        warnings: expect.arrayContaining([
          'Terminal wrap information was unavailable; capability masking used complete lines.'
        ])
      })
    }
  )

  it.each([false, true])(
    'keeps hard screen diagnostics in live and archived reads (legacy=%s)',
    async (legacy) => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker('failed')
      const fixture = await createTerminalArchiveFixture({
        provider: true,
        screenLines: ['dcap_sssss', 'PermissionDenied', 'Safe diagnostic']
      })
      fixture.runtime.onPtyData('pty-1', 'useful history\r\n', Date.now())
      vi.mocked(h.runtime.readTerminal).mockImplementation(async (_handle, opts) => {
        const read = await fixture.runtime.readTerminal(fixture.handle, opts)
        if (!legacy) {
          return read
        }
        // Older responses carry neither source nor physical wrap provenance.
        const { source: _source, tailRows: _tailRows, ...old } = read
        return old
      })
      const live = await h.call('orchestration.workerRead', {
        dispatch: dispatchId,
        source: 'terminal',
        limit: 2000
      })
      expect(readTail(live)).toContain('useful history')
      vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
        fixture.runtime.onPtyExit('pty-1', 0)
        return { handle, tabId: 'tab-worker', ptyKilled: true }
      })
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
      const stored = h.db.getWorkerTerminalArchive(dispatchId)
      expect(stored?.content).toContain('PermissionDenied')
      vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live output gone'))
      const read = await h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
      expect(read).toMatchObject({ archived: true, terminal: { nextCursor: null } })
      expect(readTail(read)).toEqual([
        'useful history',
        'dcap_sssss',
        'PermissionDenied',
        'Safe diagnostic'
      ])
    }
  )

  it('keeps hard composer breaks in stored and full archived draft output', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker('failed')
    const fixture = await createTerminalArchiveFixture({ hydrate: false, alternate: true })
    fixture.runtime.onPtyData(
      'pty-1',
      '\x1b[?1049hSafe diagnostic\r\n────────\r\n❯ dcap_sssss\r\n  PermissionDenied\x1b[1A\x1b[3G',
      Date.now()
    )
    vi.mocked(h.runtime.readTerminal).mockImplementation((_handle, opts) =>
      fixture.runtime.readTerminal(fixture.handle, opts)
    )
    const live = await h.call('orchestration.workerRead', {
      dispatch: dispatchId,
      source: 'terminal',
      limit: 2000
    })
    expect(live).toMatchObject({ terminal: { draft: 'dcap_sssss\nPermissionDenied' } })
    vi.mocked(h.runtime.closeTerminal).mockImplementation(async (handle) => {
      fixture.runtime.onPtyExit('pty-1', 0)
      return { handle, tabId: 'tab-worker', ptyKilled: true }
    })
    await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    expect(h.db.getWorkerTerminalArchive(dispatchId)?.content).toContain('PermissionDenied')
    vi.mocked(h.runtime.readTerminal).mockRejectedValue(new Error('Live output gone'))
    await expect(
      h.call('orchestration.workerRead', { dispatch: dispatchId, limit: 2000 })
    ).resolves.toMatchObject({
      archived: true,
      terminal: { draft: 'dcap_sssss\nPermissionDenied', nextCursor: null }
    })
  })
})
