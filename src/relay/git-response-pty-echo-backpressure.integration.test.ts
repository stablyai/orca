/**
 * Regression: SSH typing latency under large git responses.
 *
 * The relay and the client share ONE ordered SSH channel. A large git diff/exec
 * response sent as a single JSON-RPC frame queues megabytes into the outbound
 * pipe at once; an interactive pty.data echo emitted mid-response then sits
 * behind all of it and typing feels seconds-slow.
 *
 * These tests model the SSH channel as a congestible in-memory pipe and assert
 * deterministic byte bounds instead of wall-clock latency:
 *  - WITHOUT the fix (client does not opt in), the whole response queues ahead
 *    of a pty echo;
 *  - WITH the fix (client opts in), the response streams on the bulk lane and
 *    at most ~1 chunk frame sits ahead of the echo;
 *  - both paths reassemble the identical git result.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'
import { requestGitStreamable } from '../main/ssh/ssh-git-response-stream-reader'

import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { GIT_RESPONSE_CHUNK_SIZE } from './protocol'

// One framed git.responseChunk: base64 (4/3) + JSON envelope + header slack.
const FRAMED_CHUNK_BYTES = Math.ceil((GIT_RESPONSE_CHUNK_SIZE * 4) / 3) + 512
const SINK_HIGH_WATER_MARK = 64 * 1024

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out: ${what}`)
    }
    await new Promise((r) => setImmediate(r))
  }
}

async function waitUntilSettled(read: () => number, stableTurns = 25): Promise<void> {
  let last = read()
  let stable = 0
  while (stable < stableTurns) {
    await new Promise((r) => setImmediate(r))
    const current = read()
    if (current === last) {
      stable += 1
    } else {
      stable = 0
      last = current
    }
  }
}

type Harness = {
  mux: SshChannelMultiplexer
  dispatcher: RelayDispatcher
  gitHandler: GitHandler
  queuedBytes: () => number
  deliverAll: () => void
  startAutoDeliver: () => void
  dispose: () => void
}

function createHarness(opts: { congested: boolean }): Harness {
  let relayFeed: ((data: Buffer) => void) | null = null
  const clientDataCallbacks: ((data: Buffer) => void)[] = []

  const clientTransport: MultiplexerTransport = {
    write: (data: Buffer) => {
      // Client → relay (keystrokes, acks) is the opposite duplex direction and
      // is not blocked by relay→client congestion.
      setImmediate(() => relayFeed?.(data))
    },
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: () => {}
  }

  const outQueue: Buffer[] = []
  let queuedBytes = 0
  const drainWaiters = new Set<() => void>()
  const fireDrainIfIdle = (): void => {
    if (queuedBytes > 0) {
      return
    }
    for (const cb of Array.from(drainWaiters)) {
      drainWaiters.delete(cb)
      cb()
    }
  }

  const dispatcher = new RelayDispatcher(
    (data: Buffer) => {
      outQueue.push(data)
      queuedBytes += data.length
      if (!opts.congested) {
        return true
      }
      return queuedBytes < SINK_HIGH_WATER_MARK
    },
    {
      waitWriteDrain: (cb: () => void) => {
        drainWaiters.add(cb)
        fireDrainIfIdle()
      }
    }
  )
  relayFeed = (data: Buffer) => dispatcher.feed(data)

  const deliverAll = (): void => {
    while (outQueue.length > 0) {
      const buf = outQueue.shift()!
      queuedBytes -= buf.length
      for (const cb of clientDataCallbacks) {
        cb(buf)
      }
    }
    fireDrainIfIdle()
  }

  let autoDeliverTimer: ReturnType<typeof setInterval> | null = null
  const startAutoDeliver = (): void => {
    if (autoDeliverTimer) {
      return
    }
    autoDeliverTimer = setInterval(deliverAll, 1)
  }

  const context = new RelayContext()
  const gitHandler = new GitHandler(dispatcher, context)
  const mux = new SshChannelMultiplexer(clientTransport)

  return {
    mux,
    dispatcher,
    gitHandler,
    queuedBytes: () => queuedBytes,
    deliverAll,
    startAutoDeliver,
    dispose: () => {
      if (autoDeliverTimer) {
        clearInterval(autoDeliverTimer)
      }
      mux.dispose()
      dispatcher.dispose()
      gitHandler.dispose()
    }
  }
}

// Build a repo whose staged diff for `big.txt` is several MB so git.diff
// returns a payload well over the stream threshold.
function makeRepoWithLargeStagedDiff(dir: string): void {
  const env = { ...process.env }
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', env })
  }
  run(['init'])
  run(['config', 'user.email', 'test@test.com'])
  run(['config', 'user.name', 'Test'])
  // Distinct non-repeating lines keep the diff from compressing to nothing.
  // Stay under the render limits (120k lines / 6M chars) so the diff result
  // carries the full ~4MB content and exceeds the stream threshold.
  const lines: string[] = []
  for (let i = 0; i < 12_000; i += 1) {
    lines.push(`line ${i} ${'x'.repeat(100)}`)
  }
  writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'))
  run(['add', 'big.txt'])
}

describe('large git response vs pty.data echo head-of-line blocking', () => {
  let tmpDir: string
  let repoDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-hol-'))
    repoDir = path.join(tmpDir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    makeRepoWithLargeStagedDiff(repoDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('WITHOUT opt-in: the whole diff queues ahead of a pty echo (single-frame HOL)', async () => {
    const harness = createHarness({ congested: true })
    try {
      let queuedBytesAheadOfEcho = -1
      harness.dispatcher.onNotification('pty.data', (params) => {
        queuedBytesAheadOfEcho = harness.queuedBytes()
        harness.dispatcher.notify('pty.data', { id: params.id, data: params.data })
      })

      // Plain request WITHOUT __streamResponse: single-frame response, as today.
      const diffPromise = harness.mux.request('git.diff', {
        worktreePath: repoDir,
        filePath: 'big.txt',
        staged: true
      })
      // Let the whole single JSON-RPC frame land in the congested pipe.
      await waitUntil(() => harness.queuedBytes() > SINK_HIGH_WATER_MARK, 'diff frame queued')
      await waitUntilSettled(() => harness.queuedBytes())

      harness.mux.notify('pty.data', { id: 'pty-1', data: 'x' })
      await waitUntil(() => queuedBytesAheadOfEcho >= 0, 'echo emitted by relay')

      // The echo sits behind the entire (multi-hundred-KB) diff frame — far
      // more than a single bulk chunk would be.
      expect(queuedBytesAheadOfEcho).toBeGreaterThan(512 * 1024)

      harness.startAutoDeliver()
      const result = (await diffPromise) as { diff?: string }
      expect(typeof result).toBe('object')
    } finally {
      harness.dispose()
    }
  }, 30_000)

  it('WITH opt-in: the diff streams on the bulk lane and the echo stays bounded', async () => {
    const harness = createHarness({ congested: true })
    try {
      let queuedBytesAheadOfEcho = -1
      harness.dispatcher.onNotification('pty.data', (params) => {
        queuedBytesAheadOfEcho = harness.queuedBytes()
        harness.dispatcher.notify('pty.data', { id: params.id, data: params.data })
      })

      const diffPromise = requestGitStreamable(harness.mux, 'git.diff', {
        worktreePath: repoDir,
        filePath: 'big.txt',
        staged: true
      })
      // Deliver the sentinel response, then let the pump run into congestion.
      await waitUntil(() => harness.queuedBytes() > 0, 'sentinel queued')
      harness.deliverAll()
      await waitUntil(() => harness.queuedBytes() > 0, 'first chunk queued')
      await waitUntilSettled(() => harness.queuedBytes())

      harness.mux.notify('pty.data', { id: 'pty-1', data: 'x' })
      await waitUntil(() => queuedBytesAheadOfEcho >= 0, 'echo emitted by relay')

      // At most one in-flight bulk frame (the write that saturated the sink)
      // plus slack sits ahead of the echo.
      expect(queuedBytesAheadOfEcho).toBeLessThan(2 * FRAMED_CHUNK_BYTES)

      harness.startAutoDeliver()
      const streamed = (await diffPromise) as Record<string, unknown>
      expect(typeof streamed).toBe('object')
      expect(streamed).not.toHaveProperty('__orcaGitResponseStream')
    } finally {
      harness.dispose()
    }
  }, 30_000)

  it('streamed result equals the single-frame result', async () => {
    const harness = createHarness({ congested: false })
    try {
      harness.startAutoDeliver()
      const params = { worktreePath: repoDir, filePath: 'big.txt', staged: true }
      // Why: request both concurrently so the shared 1ms delivery pump drives
      // the plain frame and the streamed chunk/ack round-trips without either
      // starving the other on a slow CI event loop.
      const [plain, streamed] = await Promise.all([
        harness.mux.request('git.diff', params),
        requestGitStreamable(harness.mux, 'git.diff', params)
      ])
      expect(streamed).toEqual(plain)
    } finally {
      harness.dispose()
    }
  }, 30_000)

  it('rejects with an inactivity timeout when the stream stalls after the sentinel', async () => {
    const harness = createHarness({ congested: false })
    try {
      // Deliver the sentinel so reassembly begins, then stop delivering chunks
      // to model a relay pump that wedged while the channel stayed up. Without
      // the client-side inactivity deadline this promise would hang forever.
      const streamedPromise = requestGitStreamable(
        harness.mux,
        'git.diff',
        { worktreePath: repoDir, filePath: 'big.txt', staged: true },
        { inactivityTimeoutMs: 250 }
      )
      await waitUntil(() => harness.queuedBytes() > 0, 'sentinel queued')
      harness.deliverAll() // sentinel only; chunks stay undelivered
      await expect(streamedPromise).rejects.toThrow(/stalled/)
    } finally {
      harness.dispose()
    }
  }, 30_000)
})
