import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import { HistoryReader } from '../../../history/restoration/history-reader'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
const adapters: DaemonPtyAdapter[] = []

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.disconnectOnly()
    adapter.dispose()
  }
  harness?.adapter.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  harness = undefined
})

async function startHostHistory(
  spawn: Parameters<typeof startDaemonAdapterHarness>[0] = () => createMockSubprocess()
) {
  harness = await startDaemonAdapterHarness(spawn, {}, { hostHistory: true })
  const options = {
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: join(harness.dir, 'history')
  }
  const open = (): DaemonPtyAdapter => {
    const adapter = new DaemonPtyAdapter(options)
    adapters.push(adapter)
    return adapter
  }
  return { open, root: options.historyPath }
}

const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agent: 'codex' as const
}
const surface = (terminalHandle: string) => ({
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle
})

describe('host-owned attach replies', () => {
  // N1: a cached or joined adopted attach used to send its reply without the claim result.
  it('reports the adopted claim on cached and joined attaches without killing the agent', async () => {
    const child = createMockSubprocess()
    const { open } = await startHostHistory(() => child)
    const canonical = 'claimed-canonical'
    const created = await open().spawn({
      cols: 80,
      rows: 24,
      sessionId: canonical,
      agentSessionEnsure: { claim, surface: surface('term_first') }
    })
    expect(created.agentSessionEnsure?.disposition).toBe('created')
    child._simulateData('CLAIMED_ROW\r\n')
    const adopt = (handle: string) =>
      open().spawn({
        cols: 80,
        rows: 24,
        sessionId: `requested-${handle}`,
        agentSessionEnsure: { claim, surface: surface(handle) }
      })

    // The first adopt reconstructs and leaves the latest answer; the next one reuses it.
    expect((await adopt('term_cold')).agentSessionEnsure?.disposition).toBe('adopted')
    const cached = await adopt('term_cached')
    // Two adopts of one unchanged cut share a single reconstruction.
    child._simulateData('JOINED_ROW\r\n')
    const joined = await Promise.all([adopt('term_lead'), adopt('term_join')])

    for (const result of [cached, ...joined]) {
      expect(result.id).toBe(canonical)
      expect(result.agentSessionEnsure?.disposition).toBe('adopted')
    }
    expect(joined[1]!.snapshot).toContain('JOINED_ROW')
    expect(child.kill).not.toHaveBeenCalled()
    adapters.at(-1)!.write(canonical, 'still-typing')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'still-typing'))
  }, 30_000)

  // A cold attach that cannot fit its reply fails after its provisional token, cleaning up only it.
  it('cleans up an over-long cold attach and attaches normally afterwards', async () => {
    const child = createMockSubprocess()
    const { open } = await startHostHistory(() => child)
    const request = { sessionId: 'cold-oversize', cols: 80, rows: 24, cwd: '/tmp' }
    await open().spawn(request)
    child._simulateData('COLD_ROW\r\n')
    harness!.server.host.setLaunchNote(request.sessionId, {
      arm: {
        launchToken: 'oversize',
        launchConfig: { agentArgs: '', agentEnv: { BIG: '\x1b'.repeat(3 * 1024 * 1024) } }
      }
    })
    const refused = open()
    const refusedData: string[] = []
    refused.onData(({ data }) => refusedData.push(data))
    // ESC expands to six JSON bytes: about 18 MiB on the wire from 3 MiB of text.
    await expect(refused.spawn(request)).rejects.toThrow()

    harness!.server.host.setLaunchNote(request.sessionId, { retire: 'oversize' })
    const viewer = open()
    expect((await viewer.spawn(request)).snapshot).toContain('COLD_ROW')
    child._simulateData('AFTER_CLEANUP\r\n')
    viewer.write(request.sessionId, 'typed-after')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'typed-after'))
    expect(refusedData.join('')).not.toContain('AFTER_CLEANUP')
  }, 30_000)

  // NP1: a start whose fork is unknown keeps its conservative disk truth and no hold record.
  it.each([10, 100])(
    'retires %i unknown-outcome start holds and keeps their recovery',
    async (count) => {
      let fail = true
      const { open, root } = await startHostHistory((opts) => {
        if (fail) {
          // The native call threw: whether a process forked is not proven either way.
          opts.onCreationDisposition?.({ kind: 'failed', completion: Promise.resolve() })
          throw new Error('spawn outcome unknown')
        }
        return createMockSubprocess()
      })
      const adapter = open()
      const ids = Array.from({ length: count }, (_, index) => `unknown-start-${index}`)
      for (const sessionId of ids) {
        const dir = join(root, getHistorySessionDirName(sessionId))
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'meta.json'),
          JSON.stringify({
            cwd: '/tmp',
            cols: 80,
            rows: 24,
            startedAt: '2026-11-01T10:00:00Z',
            endedAt: '2026-11-01T11:00:00Z',
            exitCode: 0
          })
        )
        await expect(
          adapter.spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })
        ).rejects.toThrow()
      }

      const reader = new HistoryReader(root)
      expect(ids.every((id) => reader.probeRestorableHistory(id).status === 'restorable')).toBe(
        true
      )
      const journals = harness!.server.host.historyJournals as unknown as {
        holds: Map<string, unknown>
      }
      expect(journals.holds.size).toBe(0)
      fail = false
      await adapter.spawn({ sessionId: ids[0]!, cols: 80, rows: 24, cwd: '/tmp' })
      expect(reader.probeRestorableHistory(ids[0]!).status).toBe('restorable')
    },
    120_000
  )
})
