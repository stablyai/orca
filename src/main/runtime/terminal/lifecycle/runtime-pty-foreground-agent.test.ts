import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function pane(opts: {
  foregroundNames: string[]
  scan: () => Promise<string | null>
  pendingAttach?: () => Promise<unknown> | undefined
}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RuntimePtyForegroundAgent reads only these fields of the record.
  const pty = {
    ptyId: 'pty-1',
    connected: true,
    launchAgent: null,
    foregroundAgent: null
  } as unknown as RuntimePtyWorktreeRecord
  const names = [...opts.foregroundNames]
  const read = vi.fn(async () => (names.length > 1 ? names.shift()! : names[0]!))
  const scan = vi.fn(opts.scan)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the foreground agent calls only these two controller methods.
  const controller = {
    getForegroundProcess: read,
    confirmForegroundProcess: scan
  } as unknown as RuntimePtyController
  const foreground = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot: () => {},
    finishDelayedSnapshot: () => {},
    pendingAttach: opts.pendingAttach ?? (() => undefined)
  })
  return { pty, foreground, read, scan }
}

describe.skipIf(process.platform === 'win32')('RuntimePtyForegroundAgent', () => {
  // A pane reattached after an app restart has no launch authority; its native Claude's process
  // name is the versions/<semver> binary it runs, and only a process scan reads `claude`.
  it('names a version-named native Claude as Claude', async () => {
    const { pty, foreground } = pane({ foregroundNames: ['2.1.330'], scan: async () => 'claude' })

    await expect(foreground.refresh('pty-1')).resolves.toBe(true)

    expect(pty.foregroundAgent).toBe('claude')
  })

  it('does not scan a pane whose attach restores the Claude Orca launched', async () => {
    const attach = deferred<boolean>()
    const { pty, foreground, scan } = pane({
      foregroundNames: ['2.1.330'],
      scan: async () => 'claude',
      pendingAttach: () => attach.promise
    })

    const identified = foreground.identifyForeground('pty-1')
    pty.launchAgent = 'claude'
    attach.resolve(true)

    await expect(identified).resolves.toBe('claude')
    expect(scan).not.toHaveBeenCalled()
  })

  it('scans once while reads alternate between the version name and claude', async () => {
    const { foreground, scan } = pane({
      foregroundNames: ['2.1.330', 'claude', '2.1.330'],
      scan: async () => 'claude'
    })

    for (let i = 0; i < 3; i++) {
      await expect(foreground.identifyForeground('pty-1')).resolves.toBe('claude')
    }

    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('keeps a scan that a shell read overtook from naming Claude', async () => {
    const scanned = deferred<string | null>()
    const { pty, foreground } = pane({
      foregroundNames: ['2.1.330', 'zsh'],
      scan: () => scanned.promise
    })

    const refreshed = foreground.refresh('pty-1')
    await vi.waitFor(() => expect(foreground.getReads().size).toBe(0))
    await expect(foreground.identifyForeground('pty-1')).resolves.toBeNull()
    scanned.resolve('claude')

    await expect(refreshed).resolves.toBe(false)
    expect(pty.foregroundAgent).toBeNull()
  })

  it('reloads for a title that arrived while a scan named Claude', async () => {
    const scanned = deferred<string | null>()
    const { pty, foreground, read } = pane({
      foregroundNames: ['2.1.330', 'zsh'],
      scan: () => scanned.promise
    })

    const refreshed = foreground.refresh('pty-1', 1)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    void foreground.refresh('pty-1', 2)
    scanned.resolve('claude')

    await expect(refreshed).resolves.toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    expect(pty.foregroundAgent).toBeNull()
  })
})
