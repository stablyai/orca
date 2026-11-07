import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { getPiBackgroundWorkBridgeSource } from './rpc-background-work-bridge-source'

const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((close) => close())
  vi.useRealTimers()
})

function bridge() {
  vi.useFakeTimers()
  const dir = mkdtempSync(join(tmpdir(), 'orca-pi-workers-'))
  const bus = new EventEmitter()
  const hooks = new Map<string, (_event: unknown, ctx: unknown) => void>()
  const frames: { key: string; text: string }[] = []
  const requests: { method: string; requestId: string }[] = []
  const events = {
    jobsChanged: 'subagent:jobs-changed',
    asyncStarted: 'subagent:async-started',
    childStatus: 'subagent:child-status',
    asyncComplete: 'subagent:async-complete',
    processTerminal: 'subagent:process-terminal'
  }
  const pi = {
    on: (event: string, fn: (_event: unknown, ctx: unknown) => void) => hooks.set(event, fn),
    events: {
      on: (event: string, fn: (...args: unknown[]) => void) => {
        bus.on(event, fn)
        return () => bus.off(event, fn)
      },
      emit: (event: string, value: unknown) => bus.emit(event, value)
    }
  }
  const reply = (request: { requestId: string }, data: unknown) =>
    bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data
    })
  bus.on('subagents:rpc:v1:request', (request) => {
    if (request.method === 'ping') {
      reply(request, { capabilities: { asyncStatusSnapshot: { version: 1 } }, events })
    } else {
      requests.push(request)
    }
  })
  const ctx = {
    sessionManager: { getSessionId: () => 'session-a', getSessionFile: () => null },
    ui: { setStatus: (key: string, text: string) => frames.push({ key, text }) }
  }
  const sandbox: { extension?: (api: typeof pi) => void } & Record<string, unknown> = {
    require: createRequire(import.meta.url),
    process: { env: { ORCA_PI_BACKGROUND_WORK_DIR: dir } },
    Buffer,
    setTimeout,
    clearTimeout
  }
  runInNewContext(
    getPiBackgroundWorkBridgeSource().replace(
      'export default function',
      'globalThis.extension = function'
    ),
    sandbox
  )
  if (!sandbox.extension) {
    throw new Error('Generated Pi bridge did not export extension')
  }
  sandbox.extension(pi)
  const start = () => hooks.get('session_start')?.({}, ctx)
  const stop = () => hooks.get('session_shutdown')?.({}, ctx)
  cleanup.push(() => {
    stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const packets = () =>
    frames
      .filter((frame) => frame.key === 'orca-native-workers')
      .map((frame) => JSON.parse(frame.text))
  return {
    start,
    stop,
    packets,
    requests,
    reply,
    hint: () => bus.emit(events.childStatus, { version: 1 }),
    bus
  }
}

it('subscribes before recovery reads, refreshes hints, rejects old runtimes, and makes failed reads unknown', async () => {
  const h = bridge()
  h.start()
  await vi.advanceTimersByTimeAsync(250)
  const first = h.requests.shift()!
  h.hint()
  h.reply(first, { asyncSnapshot: { version: 1, runs: [{ id: 'observed-before-hint' }] } })
  await vi.advanceTimersByTimeAsync(250)
  expect(h.packets().at(-1)).toMatchObject({
    state: 'known',
    asyncSnapshot: { runs: [{ id: 'observed-before-hint' }] }
  })
  const recovered = h.requests.shift()!
  h.reply(recovered, { asyncSnapshot: { version: 1, runs: [{ id: 'current' }] } })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.packets().at(-1)).toMatchObject({
    state: 'known',
    asyncSnapshot: { runs: [{ id: 'current' }] }
  })
  h.hint()
  await vi.advanceTimersByTimeAsync(250)
  const previousRuntime = h.requests.shift()!
  h.start()
  h.reply(previousRuntime, { asyncSnapshot: { version: 1, runs: [{ id: 'late' }] } })
  await vi.advanceTimersByTimeAsync(250)
  expect(h.packets().at(-1)).toMatchObject({ state: 'unknown' })
  h.reply(h.requests.shift()!, { asyncSnapshot: { version: 1, runs: [] } })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.packets().at(-1)).toMatchObject({ state: 'known', asyncSnapshot: { runs: [] } })
  h.hint()
  await vi.advanceTimersByTimeAsync(5250)
  expect(h.packets().at(-1)).toMatchObject({ state: 'unknown' })
  h.stop()
  h.reply(h.requests.shift()!, {
    asyncSnapshot: { version: 1, runs: [{ id: 'late-after-shutdown' }] }
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.packets().at(-1)).toMatchObject({ state: 'unknown' })
})

it('invalidates prior workers when a hinted read times out, and accepts slow snapshots without a quiet window', async () => {
  const h = bridge()
  h.start()
  await vi.advanceTimersByTimeAsync(250)
  h.reply(h.requests.shift()!, { asyncSnapshot: { version: 1, runs: [{ id: 'worker-a' }] } })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.packets().at(-1)).toMatchObject({
    state: 'known',
    asyncSnapshot: { runs: [{ id: 'worker-a' }] }
  })
  h.hint()
  await vi.advanceTimersByTimeAsync(250)
  h.requests.shift()
  h.hint()
  await vi.advanceTimersByTimeAsync(5000)
  expect(h.packets().at(-1)).toMatchObject({ state: 'unknown' })
  await vi.advanceTimersByTimeAsync(250)
  h.hint()
  await vi.advanceTimersByTimeAsync(5000)
  expect(h.packets().at(-1)).toMatchObject({ state: 'unknown' })
  h.requests.shift()
  await vi.advanceTimersByTimeAsync(250)
  const slow = h.requests.shift()!
  h.hint()
  h.reply(slow, { asyncSnapshot: { version: 1, runs: [] } })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.packets().at(-1)).toMatchObject({ state: 'known', asyncSnapshot: { runs: [] } })
})

it('survives missing package and discovers a later ready runtime without polling', async () => {
  const h = bridge()
  h.bus.removeAllListeners('subagents:rpc:v1:request')
  h.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.packets().map((packet) => packet.state)).toEqual(['unknown'])
  h.bus.on('subagents:rpc:v1:request', (request) => {
    if (request.method === 'ping') {
      h.reply(request, {
        capabilities: { asyncStatusSnapshot: { version: 1 } },
        events: {
          jobsChanged: 'j',
          asyncStarted: 'a',
          childStatus: 'c',
          asyncComplete: 'd',
          processTerminal: 'p'
        }
      })
    } else {
      h.reply(request, { asyncSnapshot: { version: 1, runs: [] } })
    }
  })
  h.bus.emit('subagents:rpc:v1:ready', { version: 1 })
  await vi.advanceTimersByTimeAsync(4250)
  expect(h.packets().at(-1)).toMatchObject({ state: 'known', asyncSnapshot: { runs: [] } })
})
