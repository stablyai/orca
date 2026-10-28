import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from '../worker-thread-child-process/worker-thread-child-process-worker.test-fixtures'
import { readCodexRateLimitsViaRpc } from './codex-rpc-rate-limit-probe'
import { terminateCodexProbeChild } from './codex-probe-termination'

type TestEntry = Awaited<ReturnType<typeof createWorkerThreadChildProcessTestEntry>>
type TestHost = ReturnType<typeof createWorkerThreadChildProcessTestHost>

let entry: TestEntry
const hosts: TestHost[] = []

beforeAll(async () => {
  entry = await createWorkerThreadChildProcessTestEntry()
}, 60_000)

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(hosts.splice(0).map((host) => host.dispose()))
})

afterAll(async () => {
  await entry?.dispose()
})

function createHost(): TestHost {
  const host = createWorkerThreadChildProcessTestHost(entry.entryPath)
  hosts.push(host)
  return host
}

const NOISY_RPC_SCRIPT = `
const rl = require('readline').createInterface({input: process.stdin});
rl.on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    for (let i = 0; i < 64; i++) {
      await new Promise(resolve => process.stderr.write(Buffer.alloc(65536, 97), resolve));
    }
    process.stdout.write(JSON.stringify({id: request.id, result: {}}) + '\\n');
  } else if (request.method === 'account/rateLimits/read') {
    process.stdout.write(JSON.stringify({id: request.id,
      result: {rateLimits: {primary: {usedPercent: 17}}}}) + '\\n');
  }
});
`

const EOF_SCRIPT = `
const rl = require('readline').createInterface({input: process.stdin});
let stopping = false;
let noisy = false;
process.stdin.on('end', () => stopping = true);
async function writeNoise() {
  if (noisy) return;
  noisy = true;
  while (!stopping) {
    await new Promise(resolve => process.stderr.write(Buffer.alloc(65536, 97), resolve));
    await new Promise(setImmediate);
  }
}
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (process.argv[1] === 'reply-init') {
      process.stdout.write(JSON.stringify({id: request.id, result: {}}) + '\\n');
    } else {
      void writeNoise();
    }
  } else if (request.method === 'initialized') {
    void writeNoise();
  }
});
`

describe('Codex RPC over backpressured worker output', () => {
  it('delivers valid replies after noisy stderr drains without extending the RPC deadlines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const host = createHost()
    const child = host.spawn({ program: process.execPath, args: ['-e', NOISY_RPC_SCRIPT] })
    const closed = new Promise((resolve) => child.once('close', resolve))
    const terminate = vi.fn(async () => {
      child.stdin.end()
      await closed
    })
    const result = readCodexRateLimitsViaRpc({
      child,
      codexCommand: 'fixture',
      initTimeoutMs: 30_000,
      rpcTimeoutMs: 10_000,
      terminate
    })
    await host.backlogged
    await vi.advanceTimersByTimeAsync(29_000)
    expect(terminate).not.toHaveBeenCalled()
    host.releaseOutput()

    await expect(result).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 17 } })
    expect(terminate).toHaveBeenCalledOnce()
    expect(child.exitCode).toBe(0)
  })

  it.each(['initialization deadline', 'RPC deadline', 'abort'] as const)(
    'gracefully exits after %s detaches output listeners while the worker is paused',
    async (stop) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const host = createHost()
      const child = host.spawn({
        program: process.execPath,
        args: ['-e', EOF_SCRIPT, stop === 'initialization deadline' ? 'no-init' : 'reply-init']
      })
      const abort = new AbortController()
      const terminate = vi.fn(() =>
        // Exercise the stdin-EOF shutdown used on Windows on every test host.
        terminateCodexProbeChild(child, { platform: 'win32' })
      )
      const result = readCodexRateLimitsViaRpc({
        child,
        codexCommand: 'fixture',
        initTimeoutMs: 30_000,
        rpcTimeoutMs: 10_000,
        fetchOptions: { signal: abort.signal },
        terminate
      })
      await host.backlogged
      if (stop === 'abort') {
        abort.abort()
      } else {
        const deadlineMs = stop === 'initialization deadline' ? 30_000 : 10_000
        await vi.advanceTimersByTimeAsync(deadlineMs - 1)
        expect(terminate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(terminate).toHaveBeenCalledOnce()
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      host.releaseOutput()

      await expect(result).resolves.toMatchObject(
        stop === 'abort'
          ? { status: 'error', error: 'Rate-limit fetch aborted' }
          : { status: 'error', error: 'RPC timeout' }
      )
      expect(child.exitCode).toBe(0)
    }
  )
})
