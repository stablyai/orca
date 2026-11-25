import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import type * as NetModule from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY
} from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { getRuntimeMetadataPath } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { RuntimeClient } from '../client'
import { RuntimeClientError } from './types'
import { callOrchestrationMutation } from '../../orchestration/recovery/mutation-request'

// A dial the test holds never connects, so the transport writes nothing on it.
const { dials } = vi.hoisted(() => ({
  dials: { hold: new Set<number>(), count: 0, onHeld: (): void => {} }
}))
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof NetModule>()
  return {
    ...actual,
    createConnection: (...args: Parameters<typeof actual.createConnection>) => {
      dials.count += 1
      if (dials.hold.has(dials.count)) {
        dials.onHeld()
        return new actual.Socket()
      }
      return actual.createConnection(...args)
    }
  }
})

const TIMEOUT_MS = 5_000
const RUNTIME_ID = 'local-pre-write-runtime'
const ARGS = [
  'orchestration',
  'send',
  '--type',
  'worker_done',
  '--subject',
  'done',
  '--task-id',
  'task_1',
  '--dispatch-id',
  'ctx_1'
]
const PARAMS = { type: 'worker_done', subject: 'done', from: 'term_worker' }

type Frame = { id: string; method: string; orchestrationRequestId?: string }

let profile = ''
let server: Server
let frames: Frame[] = []
let onMutationFrame: () => void = () => {}

beforeEach(async () => {
  for (const name of [
    'ORCA_RUNTIME_SOURCE_ID',
    'ORCA_RUNTIME_SOURCE_INCARNATION',
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_ENVIRONMENT'
  ]) {
    vi.stubEnv(name, '')
  }
  dials.hold = new Set()
  dials.count = 0
  frames = []
  profile = await mkdtemp(join(tmpdir(), 'orca-pre-write-'))
  const windows = process.platform === 'win32'
  const endpoint = windows
    ? `\\\\.\\pipe\\orca-pre-write-${randomUUID()}`
    : join(profile, 'runtime.sock')
  server = createServer((socket) => {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', (chunk: string) => {
      input += chunk
      const lines = input.split('\n')
      input = lines.pop() ?? ''
      for (const line of lines) {
        const frame: Frame = JSON.parse(line)
        frames.push(frame)
        if (frame.method === 'status.get') {
          const result = {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY
            ]
          }
          socket.write(
            `${JSON.stringify({ id: frame.id, ok: true, result, _meta: { runtimeId: RUNTIME_ID } })}\n`
          )
        } else {
          // The runtime takes the mutation but its reply never comes back.
          onMutationFrame()
        }
      }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  await writeFile(
    getRuntimeMetadataPath(profile),
    JSON.stringify({
      runtimeId: RUNTIME_ID,
      pid: process.pid,
      authToken: 'fixture',
      startedAt: Date.now(),
      transports: [{ kind: windows ? 'named-pipe' : 'unix', endpoint }]
    }),
    { mode: 0o600 }
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(profile, { recursive: true, force: true })
})

function client(args: readonly string[]) {
  return new RuntimeClient(profile, 1_000, null, null, 'orca', args)
}

/** Resolves when the dial the test holds has been opened. */
function held(): Promise<void> {
  return new Promise((resolve) => {
    dials.onHeld = resolve
  })
}

function mutationFrame(): Promise<void> {
  return new Promise((resolve) => {
    onMutationFrame = resolve
  })
}

function mutationFrames() {
  return frames.filter((frame) => frame.method !== 'status.get')
}

async function failure(pending: Promise<unknown>): Promise<RuntimeClientError> {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught
  )
  if (!(error instanceof RuntimeClientError)) {
    throw new Error(`expected a runtime client error, got ${String(error)}`)
  }
  return error
}

describe('a local mutation dial that times out before its frame is written', () => {
  it('keeps an explicit retry key and asks to inspect it, since an earlier attempt may have run', async () => {
    const retryKey = randomUUID()
    const flags = new Map<string, string | boolean>([['retry-request', retryKey]])
    // Dial 1 is the separate contract probe; dial 2 carries the mutation.
    dials.hold.add(2)
    const opened = held()

    const pending = failure(
      callOrchestrationMutation(
        client([...ARGS, '--retry-request', retryKey]),
        flags,
        'orchestration.send',
        PARAMS,
        { timeoutMs: TIMEOUT_MS },
        0
      )
    )
    await opened
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const error = await pending

    expect(frames.map((frame) => frame.method)).toEqual(['status.get'])
    expect(mutationFrames()).toEqual([])
    expect(dials.count).toBe(2)
    expect(error.code).toBe('runtime_timeout')
    expect(error.data).toMatchObject({
      requestSent: false,
      orchestrationRequestId: retryKey,
      originalCommand: ['orca', ...ARGS],
      recovery: {
        orchestrationRequestId: retryKey,
        disposition: 'outcome_unknown',
        queryCommand: ['orca', 'orchestration', 'request-show', '--request', retryKey, '--json'],
        retryCommand: ['orca', ...ARGS, '--retry-request', retryKey]
      }
    })
    expect(error.message).toContain('may already have taken effect')
  })

  it('reports a fresh key as never sent, with its key for a safe rerun', async () => {
    dials.hold.add(2)
    const opened = held()

    const pending = failure(
      callOrchestrationMutation(
        client(ARGS),
        new Map(),
        'orchestration.send',
        PARAMS,
        { timeoutMs: TIMEOUT_MS },
        0
      )
    )
    await opened
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const error = await pending

    expect(mutationFrames()).toEqual([])
    expect(dials.count).toBe(2)
    const requestId = (error.data as { orchestrationRequestId?: unknown }).orchestrationRequestId
    expect(requestId).toEqual(expect.any(String))
    expect(error.data).toMatchObject({
      requestSent: false,
      originalCommand: ['orca', ...ARGS],
      recovery: {
        disposition: 'not_sent',
        retryCommand: ['orca', ...ARGS, '--retry-request', requestId]
      }
    })
    expect(error.message).toContain('Nothing was sent')
  })

  it('still reports the earlier possibly delivered timeout when a later replay dial times out unsent', async () => {
    dials.hold.add(3)
    const written = mutationFrame()
    const opened = held()

    const pending = failure(
      callOrchestrationMutation(
        client(ARGS),
        new Map(),
        'orchestration.send',
        PARAMS,
        { timeoutMs: TIMEOUT_MS },
        60_000
      )
    )
    await written
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    // Backoff, then the replay dial the test holds.
    await vi.advanceTimersByTimeAsync(1_000)
    await opened
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const error = await pending

    const sent = mutationFrames()
    expect(sent).toHaveLength(1)
    expect(dials.count).toBe(3)
    expect(error.data).not.toHaveProperty('requestSent')
    expect(error.data).toMatchObject({
      orchestrationRequestId: sent[0]?.orchestrationRequestId,
      recovery: { disposition: 'outcome_unknown' }
    })
  })
})
