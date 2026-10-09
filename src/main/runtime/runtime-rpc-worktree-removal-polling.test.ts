import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { createConnection } from 'node:net'
import { openFramedSession, sleep, waitFor } from './runtime-rpc-test-harness'

const REMOVALS = 50

type Call = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>

// One request per connection, as the CLI sends them; a dropped connection rejects instead of hanging.
function request(
  endpoint: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('close', () => reject(new Error('closed before replying')))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        resolve(JSON.parse(buffer.slice(0, newline)))
        socket.end()
      }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`))
  })
}

async function poll(call: Call, worktreeId: string): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call('worktree.removalState', { worktreeId, hostId: 'local' })
    } catch (error) {
      if (attempt === 3) {
        throw error
      }
    }
  }
}

// The CLI's protocol (src/cli/handlers/worktree-removal-outcome.ts, which this project cannot
// import): a plain `worktree.rm`, then `worktree.removalState` polls until the delete settles,
// riding out a dropped connection on a poll as the CLI does.
async function removeAndPoll(
  call: Call,
  worktreeId: string,
  timing: { startMs: number; pollMs: number }
): Promise<object> {
  // Why staggered: this stand-in client does not recover a dropped `worktree.rm`; the CLI's own
  // recovery from the socket's 32-connection limit is src/cli/worktree-rm-connection-limit.test.ts.
  await sleep(timing.startMs)
  const accepted = await call('worktree.rm', { worktree: `id:${worktreeId}`, hostId: 'local' })
  expect(accepted).toMatchObject({ ok: true, result: { removing: true } })
  for (;;) {
    await sleep(timing.pollMs)
    const reply = await poll(call, worktreeId)
    expect(reply).toMatchObject({ ok: true })
    const state = reply.result
    if (!(typeof state === 'object' && state !== null && 'state' in state)) {
      throw new Error('worktree.removalState answered without a state')
    }
    if (state.state !== 'removing') {
      return state
    }
  }
}

describe('many CLI deletes waiting on their outcomes at once', () => {
  it('each waits on its own removal without holding a long-poll slot', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const finished = new Set<string>()
    vi.spyOn(runtime, 'removeManagedWorktree').mockResolvedValue({ removing: true })
    vi.spyOn(runtime, 'readWorktreeRemovalState').mockImplementation(async (worktreeId) =>
      finished.has(worktreeId) ? { state: 'removed' } : { state: 'removing' }
    )
    // Why a cap of 1: a single delete holding a long-poll slot would turn the wait below away.
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, longPollCap: 1 })
    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)!
      const endpoint = metadata.transports[0]!.endpoint
      const call: Call = (method, params) =>
        request(endpoint, { id: `req_${method}`, authToken: metadata.authToken, method, params })
      const settled: string[] = []
      const removals = Array.from({ length: REMOVALS }, (_, index) => {
        const worktreeId = `repo-1::/tmp/wt-${index}`
        return removeAndPoll(call, worktreeId, {
          startMs: index * 3,
          pollMs: 20 + (index % 7) * 5
        }).then((state) => {
          settled.push(worktreeId)
          return state
        })
      })
      await waitFor(
        () => vi.mocked(runtime.removeManagedWorktree).mock.calls.length === REMOVALS,
        10_000
      )
      const readsBefore = vi.mocked(runtime.readWorktreeRemovalState).mock.calls.length
      await waitFor(
        () =>
          vi.mocked(runtime.readWorktreeRemovalState).mock.calls.length >= readsBefore + REMOVALS,
        10_000
      )

      // Another client's long poll is admitted while all of them wait.
      const wait = openFramedSession(endpoint, {
        id: 'req_terminal_wait',
        authToken: metadata.authToken,
        method: 'terminal.wait',
        params: { terminal: 'term_missing', for: 'exit', timeoutMs: 50 }
      })
      await wait.done
      const reply = wait.frames.find((frame) => frame.ok !== undefined)
      expect(reply).toMatchObject({ ok: false })
      expect(reply?.error).not.toMatchObject({ code: 'runtime_busy' })
      expect(server['activeLongPolls']).toBe(0)

      // Each returns when its own removal finishes, not behind the others.
      finished.add('repo-1::/tmp/wt-7')
      await waitFor(() => settled.length === 1, 5_000)
      expect(settled).toEqual(['repo-1::/tmp/wt-7'])

      for (let index = 0; index < REMOVALS; index += 1) {
        finished.add(`repo-1::/tmp/wt-${index}`)
      }
      expect(await Promise.all(removals)).toEqual(
        Array.from({ length: REMOVALS }, () => ({ state: 'removed' }))
      )
    } finally {
      await server.stop()
    }
  }, 30_000)
})
