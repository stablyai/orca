import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { HistoryReader } from '../../../history/restoration/history-reader'
import type * as CheckpointReaderModule from '../../../history/restoration/terminal-history-checkpoint-reader'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

const probe = vi.hoisted(() => ({ cwd: null as string | null, during: () => {} }))
// The probe itself reads a real shell's folder; here it reports a chosen one.
vi.mock('../daemon-live-sleep-cwd', () => ({
  readDaemonSleepFolder: async () => {
    probe.during()
    return probe.cwd
  }
}))

// Another writer may touch a session's files while a cold read is acquiring them.
const sourceChange = vi.hoisted(() => ({ during: (): void => {} }))
vi.mock(
  '../../../history/restoration/terminal-history-checkpoint-reader',
  async (importOriginal) => {
    const actual = await importOriginal<typeof CheckpointReaderModule>()
    return {
      ...actual,
      readTerminalHistoryCheckpoint: async (
        ...args: Parameters<typeof actual.readTerminalHistoryCheckpoint>
      ) => {
        const read = await actual.readTerminalHistoryCheckpoint(...args)
        sourceChange.during()
        return read
      }
    }
  }
)

type MockChild = ReturnType<typeof createMockSubprocess>
let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
const adapters: DaemonPtyAdapter[] = []
const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  probe.cwd = null
  probe.during = () => {}
  sourceChange.during = () => {}
  for (const adapter of adapters.splice(0)) {
    adapter.dispose()
  }
  await harness?.server.shutdown()
  for (const dir of [harness?.dir, ...dirs.splice(0)]) {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  harness = undefined
})

async function startHost() {
  const children: MockChild[] = []
  const spawnCwds: (string | undefined)[] = []
  harness = await startDaemonAdapterHarness(
    (opts) => {
      spawnCwds.push(opts.cwd)
      const child = createMockSubprocess()
      children.push(child)
      return child
    },
    {},
    { hostHistory: true }
  )
  const historyPath = join(harness.dir, 'history')
  const options = { socketPath: harness.socketPath, tokenPath: harness.tokenPath, historyPath }
  const open = (): DaemonPtyAdapter => {
    const adapter = new DaemonPtyAdapter(options)
    adapters.push(adapter)
    return adapter
  }
  return { children, spawnCwds, open, historyPath, child: () => children.at(-1)! }
}

function existingFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sleep-folder-'))
  dirs.push(dir)
  return dir
}

/** A process whose termination prints more output before it physically exits. */
function exitAfterOutput(child: MockChild, output: string, delayMs = 5): void {
  vi.mocked(child.kill).mockImplementation(() => {
    child._simulateData(output)
    setTimeout(() => child._simulateExit(0), delayMs)
  })
}

const request = (sessionId: string) => ({ sessionId, cols: 100, rows: 30, cwd: '/tmp' })

describe('host Sleep through disk-only Wake', () => {
  // Two real Sleep and disk-only Wake cycles through the daemon, its files and replay.
  it('wakes the probed folder, retained rows and geometry, then sleeps and wakes again', async () => {
    const { open, child, spawnCwds } = await startHost()
    const sessionId = 'sleep-wake'
    const slept = open()
    await slept.spawn(request(sessionId))
    child()._simulateData('\x1b]7;file://host/tmp\x07BEFORE_SLEEP\r\n')
    probe.cwd = existingFolder()
    // Termination-time output, including a real OSC 7 that the Sleep probe still overrides.
    exitAfterOutput(child(), '\x1b]7;file://host/var\x07DURING_TERMINATION\r\n')
    await slept.shutdown(sessionId, { keepHistory: true })
    expect(harness!.server.host.listSessions()).toEqual([])

    const woken = await open().spawn({ ...request(sessionId), cols: 80, rows: 24 })
    expect(woken.coldRestore?.scrollback).toContain('BEFORE_SLEEP')
    expect(woken.coldRestore?.scrollback).toContain('DURING_TERMINATION')
    expect([woken.coldRestore?.cols, woken.coldRestore?.rows]).toEqual([100, 30])
    expect(spawnCwds.at(-1)).toBe(probe.cwd)

    const second = existingFolder()
    probe.cwd = second
    child()._simulateData('AFTER_WAKE\r\n')
    exitAfterOutput(child(), '')
    await adapters.at(-1)!.shutdown(sessionId, { keepHistory: true })
    const again = await open().spawn(request(sessionId))
    expect(again.coldRestore?.scrollback).toContain('AFTER_WAKE')
    expect(spawnCwds.at(-1)).toBe(second)
  }, 30_000)

  // A real daemon teardown runs to its settled, refused end before the assertions.
  it('leaves the terminal running when its root signal is refused', async () => {
    const { open, child, historyPath } = await startHost()
    const sessionId = 'sleep-refused'
    const adapter = open()
    await adapter.spawn(request(sessionId))
    child()._simulateData('REFUSED_ROW\r\n')
    vi.mocked(child().kill).mockImplementation(() => {
      throw new Error('signal refused')
    })

    await expect(adapter.shutdown(sessionId, { keepHistory: true })).rejects.toThrow()
    adapter.write(sessionId, 'still-typing')
    await waitFor(() => child().write.mock.calls.some(([data]) => data === 'still-typing'))
    // Sleep released the terminal: its later natural exit ends history normally.
    child()._simulateExit(0)
    const metaPath = join(historyPath, getHistorySessionDirName(sessionId), 'meta.json')
    await waitFor(() => JSON.parse(readFileSync(metaPath, 'utf8')).endedAt !== null, 10_000)
  }, 30_000)

  // A real daemon Sleep request runs through its probe, admission and refusal.
  it('kills nothing when the process exits on its own before Sleep authorizes', async () => {
    const { open, child } = await startHost()
    const sessionId = 'sleep-natural-exit'
    const adapter = open()
    await adapter.spawn(request(sessionId))
    probe.during = () => child()._simulateExit(0)

    await expect(adapter.shutdown(sessionId, { keepHistory: true })).rejects.toThrow()
    expect(child().kill).not.toHaveBeenCalled()
  }, 30_000)

  // The final cut is published after a delayed physical exit and a successor start.
  it('finishes the final cut after its caller gives up, and touches no successor', async () => {
    const { open, child } = await startHost()
    const sessionId = 'sleep-late-caller'
    const adapter = open()
    await adapter.spawn(request(sessionId))
    child()._simulateData('LATE_ROW\r\n')
    exitAfterOutput(child(), 'LATE_EXIT\r\n', 400)

    await expect(
      adapter.shutdown(sessionId, {
        keepHistory: true,
        // ast-grep-ignore: test-no-wall-clock -- Sleep's deadline is an absolute epoch the real daemon compares against.
        deadlineMs: Date.now() + 150
      })
    ).rejects.toThrow()
    await waitFor(() => harness!.server.host.listSessions().length === 0, 10_000)
    await harness!.server.host.historyJournals!.settleAll()
    const successor = await adapter.spawn(request(sessionId))
    expect(successor.coldRestore?.scrollback).toContain('LATE_EXIT')
    adapter.write(sessionId, 'successor-input')
    await waitFor(() => child().write.mock.calls.some(([data]) => data === 'successor-input'))
    expect(child().kill).not.toHaveBeenCalled()
  }, 30_000)

  // A source that keeps changing under a cold read is not absent, corrupt or a fresh start.
  it('refuses a Wake whose saved source keeps changing, then restores it on Retry', async () => {
    const { open, child, historyPath } = await startHost()
    const sessionId = 'sleep-changing-source'
    await open().spawn(request(sessionId))
    child()._simulateData('SAVED_ROW\r\n')
    probe.cwd = existingFolder()
    exitAfterOutput(child(), '')
    await adapters.at(-1)!.shutdown(sessionId, { keepHistory: true })
    const dir = join(historyPath, getHistorySessionDirName(sessionId))
    const saved = Object.fromEntries(
      readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')])
    )
    const historyEntries = readdirSync(historyPath).sort()
    let touches = 0
    sourceChange.during = () => {
      touches += 1
      utimesSync(join(dir, 'meta.json'), touches, touches)
    }
    const waking = open()

    await expect(waking.spawn(request(sessionId))).rejects.toThrow('terminal_history_unavailable')
    expect(harness!.server.host.listSessions()).toEqual([])
    expect(readdirSync(historyPath).sort()).toEqual(historyEntries)
    for (const [name, content] of Object.entries(saved)) {
      expect(readFileSync(join(dir, name), 'utf8')).toBe(content)
    }

    sourceChange.during = () => {}
    const retried = await waking.spawn(request(sessionId))
    expect(retried.coldRestore?.scrollback).toContain('SAVED_ROW')
  }, 30_000)
})

describe('quit commits every captured host session', () => {
  // Real quit commits through the daemon socket and file publication.
  it('makes recent output durable before the daemon could be lost, within one budget', async () => {
    const { open, children, historyPath } = await startHost()
    const adapter = open()
    await adapter.spawn(request('quit-recent'))
    await adapter.spawn(request('quit-quiet'))
    children[0]._simulateData('RECENT_ROW\r\n')
    children[1]._simulateData('QUIET_ROW\r\n')

    await adapter.disconnectOnly()
    // Read the files at once: nothing waits for the ordinary one-second append window.
    const reader = new HistoryReader(historyPath)
    for (const [sessionId, row] of [
      ['quit-recent', 'RECENT_ROW'],
      ['quit-quiet', 'QUIET_ROW']
    ]) {
      const restored = await reader.detectColdRestore(sessionId, { ignoreCleanEnd: true })
      expect(restored?.snapshotAnsi).toContain(row)
    }
    expect(children.every((child) => vi.mocked(child.kill).mock.calls.length === 0)).toBe(true)
  }, 30_000)

  // A relaunched app can bind a session no pane mounted; its output still needs its cut.
  it('commits a bound session that no pane has mounted', async () => {
    const { open, child, historyPath } = await startHost()
    const sessionId = 'quit-bound-unmounted'
    const before = open()
    await before.spawn(request(sessionId))
    await before.disconnectOnly()
    const relaunched = open()
    expect((await relaunched.listProcesses()).map((process) => process.id)).toContain(sessionId)
    // A Sleep that cannot end the process leaves it bound to this app but never mounted.
    vi.mocked(child().kill).mockImplementation(() => {
      throw new Error('signal refused')
    })
    await expect(relaunched.shutdown(sessionId, { keepHistory: true })).rejects.toThrow()
    child()._simulateData('UNMOUNTED_ROW\r\n')

    await relaunched.disconnectOnly()
    const restored = await new HistoryReader(historyPath).detectColdRestore(sessionId, {
      ignoreCleanEnd: true
    })
    expect(restored?.snapshotAnsi).toContain('UNMOUNTED_ROW')
  }, 30_000)
})
