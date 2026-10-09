import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { _resetPtyOwnerHostColorsForTest } from '../../shared/pty-owner-color-query-colors'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

const QUERY = '\x1b]11;?\x07'
const WHITE = { foreground: '#2e3434', background: '#ffffff' }
const BLACK = { foreground: '#ffffff', background: '#000000' }
const SOLARIZED = { foreground: '#839496', background: '#002b36' }
const MONOKAI = { foreground: '#f8f8f2', background: '#272822' }
const WHITE_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
const BLACK_REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\'
const SOLARIZED_REPLY = '\x1b]11;rgb:0000/2b2b/3636\x1b\\'
const MONOKAI_REPLY = '\x1b]11;rgb:2727/2828/2222\x1b\\'

type MockSubprocess = ReturnType<typeof createMockSubprocess>

// Drops only this client's transport; the daemon and the adapter's event listener survive.
class TransportProbeAdapter extends DaemonPtyAdapter {
  dropTransport(): void {
    this.client.disconnect()
  }
}

// Why re-query: colour pushes are fire-and-forget notifications, so poll until one lands.
async function waitForReply(session: MockSubprocess, reply: string): Promise<void> {
  await waitFor(() => {
    session._simulateData(QUERY)
    return session.write.mock.calls.some(([written]) => written === reply)
  })
}

async function nextReply(session: MockSubprocess): Promise<unknown> {
  session.write.mockClear()
  session._simulateData(QUERY)
  await waitFor(() => session.write.mock.calls.length === 1)
  return session.write.mock.calls[0][0]
}

describe('daemon OSC 10/11 colours', () => {
  let harness: DaemonAdapterHarness
  let subprocess: ReturnType<typeof createMockSubprocess>
  let secondAdapter: DaemonPtyAdapter | null = null
  let probe: TransportProbeAdapter | null = null

  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
  })

  afterEach(async () => {
    secondAdapter?.dispose()
    secondAdapter = null
    probe?.dispose()
    probe = null
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    _resetPtyOwnerHostColorsForTest()
  })

  it('answers from the default theme until colours are pushed, then from the latest push', async () => {
    await harness.adapter.spawn({ cols: 80, rows: 24 })

    subprocess._simulateData(QUERY)
    await waitFor(() => subprocess.write.mock.calls.length === 1)
    harness.adapter.setColorQueryReplyColors({ foreground: '#000000', background: '#123456' })
    // Why a second query to wait on: the push is a fire-and-forget notification.
    await waitFor(() => {
      subprocess._simulateData(QUERY)
      return subprocess.write.mock.calls.some(
        ([reply]) => reply === '\x1b]11;rgb:1212/3434/5656\x1b\\'
      )
    })

    expect(subprocess.write.mock.calls[0]).toEqual(['\x1b]11;rgb:2828/2c2c/3434\x1b\\'])
  })

  it('resends the last colours when an adapter connects, so a push made while offline lands', async () => {
    secondAdapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    secondAdapter.setColorQueryReplyColors({ foreground: '#000000', background: '#abcdef' })
    await secondAdapter.spawn({ cols: 80, rows: 24 })

    await waitFor(() => {
      subprocess._simulateData(QUERY)
      return subprocess.write.mock.calls.some(
        ([reply]) => reply === '\x1b]11;rgb:abab/cdcd/efef\x1b\\'
      )
    })
    // The value is daemon-wide: a session another client spawned answers the same way.
    await harness.adapter.spawn({ cols: 80, rows: 24 })
    subprocess._simulateData(QUERY)
    await waitFor(() => subprocess.write.mock.calls.length === 1)
    expect(subprocess.write.mock.calls[0]).toEqual(['\x1b]11;rgb:abab/cdcd/efef\x1b\\'])
  })

  it("answers a themed project's session from its project colours, live, after startup", async () => {
    harness.adapter.setColorQueryReplyColors(WHITE, { 'repo-a': SOLARIZED })
    const { id } = await harness.adapter.spawn({ cols: 80, rows: 24, worktreeId: 'repo-a::/a' })
    const themed = subprocess
    await harness.adapter.spawn({ cols: 80, rows: 24, worktreeId: 'repo-b::/b' })
    const unthemed = subprocess
    await harness.adapter.closeStartupQueryAuthority(id)

    await waitForReply(themed, SOLARIZED_REPLY)
    expect(await nextReply(unthemed)).toBe(WHITE_REPLY)

    harness.adapter.setColorQueryReplyColors(WHITE, { 'repo-a': MONOKAI })
    await waitForReply(themed, MONOKAI_REPLY)

    // Clearing the project's theme falls back to the host-wide colours.
    harness.adapter.setColorQueryReplyColors(WHITE, {})
    await waitForReply(themed, WHITE_REPLY)
  })

  it('keeps the project colours a surviving daemon holds until the new app publishes its own', async () => {
    harness.adapter.setColorQueryReplyColors(WHITE, { 'repo-a': SOLARIZED })
    await harness.adapter.spawn({ cols: 80, rows: 24, worktreeId: 'repo-a::/a' })
    const themed = subprocess
    await waitForReply(themed, SOLARIZED_REPLY)

    // A relaunched app knows its host colours before its renderer publishes project themes.
    secondAdapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    secondAdapter.setColorQueryReplyColors(BLACK)
    await secondAdapter.spawn({ cols: 80, rows: 24 })
    await waitForReply(subprocess, BLACK_REPLY)

    expect(await nextReply(themed)).toBe(SOLARIZED_REPLY)
  })

  it('resends a push dropped during a client-side transport gap when the adapter reconnects', async () => {
    probe = new TransportProbeAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    probe.setColorQueryReplyColors(WHITE, { 'repo-a': SOLARIZED })
    await probe.spawn({ cols: 80, rows: 24, worktreeId: 'repo-a::/a' })
    const themed = subprocess
    await waitForReply(themed, SOLARIZED_REPLY)

    // The daemon stays alive and the adapter keeps its event listener, so this is no fresh connect.
    probe.dropTransport()
    probe.setColorQueryReplyColors(WHITE, { 'repo-a': MONOKAI })
    await probe.spawn({ cols: 80, rows: 24, worktreeId: 'repo-b::/b' })

    await waitForReply(themed, MONOKAI_REPLY)
  })

  it('resends its colours to a daemon that replaced the one it lost, without its own respawn', async () => {
    harness.adapter.setColorQueryReplyColors(WHITE, { 'repo-a': SOLARIZED })
    await harness.adapter.spawn({ cols: 80, rows: 24, worktreeId: 'repo-a::/a' })
    await waitForReply(subprocess, SOLARIZED_REPLY)

    await harness.server.shutdown()
    // A new daemon process starts with no colours.
    _resetPtyOwnerHostColorsForTest()
    harness.server = new DaemonServer({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      spawnSubprocess: () => {
        subprocess = createMockSubprocess()
        return subprocess
      }
    })
    await harness.server.start()
    await waitFor(() => !harness.adapter.getDaemonIdentity())

    await harness.adapter.spawn({ cols: 80, rows: 24, worktreeId: 'repo-a::/a' })
    await waitForReply(subprocess, SOLARIZED_REPLY)
  })

  it('answers a caller-supplied session id from the worktree the spawn names', async () => {
    harness.adapter.setColorQueryReplyColors(WHITE, { 'repo-a': SOLARIZED })
    // A pane persisted with an in-process numeric id, reattached under a healthy daemon.
    const { id } = await harness.adapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: '7',
      worktreeId: 'repo-a::/a'
    })

    expect(id).toBe('7')
    await waitForReply(subprocess, SOLARIZED_REPLY)
  })

  it('still resolves the project from a minted session id when the spawn names no worktree', async () => {
    harness.adapter.setColorQueryReplyColors(WHITE, { 'repo-a': SOLARIZED })
    await harness.adapter.spawn({ cols: 80, rows: 24, sessionId: 'repo-a::/a@@0f8fad5b' })

    await waitForReply(subprocess, SOLARIZED_REPLY)
  })
})
