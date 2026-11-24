import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  getRuntimeMetadataPath,
  type RuntimeMetadata
} from '../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import {
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
} from '../../shared/remote-runtime/host-catalog/runtime-source-env'
import {
  MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../shared/remote-runtime/protocol/host-runtime-capabilities'
import { RuntimeClient } from '../runtime/client'
import { MANAGED_SERVER_HANDLERS } from './managed-server'

// What a desktop from before limited force advertises: managed servers, but full force for --force.
const LEGACY = [MANAGED_SERVER_RUNTIME_CAPABILITY]
const CURRENT = [MANAGED_SERVER_RUNTIME_CAPABILITY, MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY]
const DEFERRAL = {
  outcome: 'deferred',
  code: 'orcad_update_terminal_census_unavailable',
  reason: 'Synthetic deferral.',
  forceable: true
}
const ROLLED_BACK = {
  outcome: 'rolled-back',
  environment: { name: 'build-box' },
  activeVersion: 'v1'
}

const RequestFrame = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
  authToken: z.unknown().optional(),
  expectedRuntimeSource: z.unknown().optional()
})

type Frame = {
  runtime: string
  connection: number
  method: string
  params: unknown
  authToken: unknown
  expectedRuntimeSource: unknown
}

let root: string
let frames: Frame[]
let servers: Server[]
let sockets: Set<Socket>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-ms-'))
  mkdirSync(dirname(getRuntimeMetadataPath(root)), { recursive: true })
  frames = []
  servers = []
  sockets = new Set()
  // A terminal launched by Orca carries a source stamp; these cases fence only where they set one.
  for (const name of [
    RUNTIME_SOURCE_ID_ENV,
    RUNTIME_SOURCE_INCARNATION_ENV,
    RUNTIME_SOURCE_PROFILE_PATH_ENV
  ]) {
    vi.stubEnv(name, '')
  }
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const socket of sockets) {
    socket.destroy()
  }
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
  rmSync(root, { recursive: true, force: true })
})

function select(metadata: RuntimeMetadata): void {
  writeFileSync(getRuntimeMetadataPath(root), JSON.stringify(metadata))
}

type RuntimeOptions = {
  onStatus?: () => void
  /** How `status.get` is answered; a capability list by default. */
  status?:
    | 'error'
    | 'unknown-method'
    | 'close'
    | 'silent'
    | { result: unknown }
    | { hold: (reply: () => void) => void }
  /** Holds the update reply until the returned release is called. */
  holdUpdate?: (release: () => void) => void
  /** Closes the connection, never answers, or answers as a desktop without the update method. */
  update?: 'close' | 'silent' | 'unknown-method'
}

/** A local desktop runtime on a real socket that records every request frame it reads. */
async function startRuntime(
  runtimeId: string,
  capabilities: string[],
  { onStatus, status, holdUpdate, update }: RuntimeOptions = {}
): Promise<RuntimeMetadata> {
  const metadata: RuntimeMetadata = {
    runtimeId,
    pid: process.pid,
    authToken: `token-${runtimeId}`,
    startedAt: 1,
    // Windows local runtimes listen on named pipes; each listener needs its own.
    transports: [
      process.platform === 'win32'
        ? { kind: 'named-pipe', endpoint: `\\\\.\\pipe\\orca-ms-${runtimeId}-${randomUUID()}` }
        : { kind: 'unix', endpoint: join(root, `${runtimeId}.sock`) }
    ]
  }
  let connections = 0
  const server = createServer((socket) => {
    const connection = ++connections
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // A late reply can race the client's close; the frame log is the oracle, not the write.
    socket.on('error', () => {})
    createInterface({ input: socket }).on('line', (line) => {
      const request = RequestFrame.parse(JSON.parse(line))
      frames.push({
        runtime: runtimeId,
        connection,
        method: request.method,
        params: request.params,
        authToken: request.authToken,
        expectedRuntimeSource: request.expectedRuntimeSource
      })
      const write = (frame: Record<string, unknown>): void => {
        socket.write(`${JSON.stringify({ id: request.id, _meta: { runtimeId }, ...frame })}\n`)
      }
      if (request.method === 'status.get') {
        onStatus?.()
        const answer = (): void => write({ ok: true, result: { capabilities } })
        if (status === 'close') {
          socket.destroy()
        } else if (status === 'error' || status === 'unknown-method') {
          const code = status === 'error' ? 'runtime_busy' : 'method_not_found'
          write({ ok: false, error: { code, message: 'Synthetic status error.' } })
        } else if (typeof status === 'object' && 'result' in status) {
          write({ ok: true, result: status.result })
        } else if (typeof status === 'object') {
          status.hold(answer)
        } else if (status !== 'silent') {
          answer()
        }
        return
      }
      // A healthy status, so a CLI that wrongly reports a restart from it succeeds visibly.
      if (request.method === 'managedServer.status') {
        write({ ok: true, result: { activeVersion: 'v2' } })
        return
      }
      if (request.method === 'managedServer.rollback') {
        write({ ok: true, result: ROLLED_BACK })
        return
      }
      if (update === 'close') {
        socket.destroy()
        return
      }
      if (update === 'unknown-method') {
        write({ ok: false, error: { code: 'method_not_found', message: 'Synthetic.' } })
        return
      }
      const reply = (): void => write({ ok: true, result: DEFERRAL })
      if (holdUpdate) {
        holdUpdate(reply)
      } else if (update !== 'silent') {
        reply()
      }
    })
  })
  servers.push(server)
  server.listen(metadata.transports[0]!.endpoint)
  await once(server, 'listening')
  return metadata
}

function methods(): string[] {
  return frames.map(({ method }) => method)
}

/** [runtime, connection, method] per frame: shows which socket carried each request. */
function routes(): [string, number, string][] {
  return frames.map(({ runtime, connection, method }) => [runtime, connection, method])
}

function run(command: string, flags: Record<string, boolean>): Promise<void> {
  return MANAGED_SERVER_HANDLERS[command]!({
    flags: new Map<string, string | boolean>([
      ['environment', 'build-box'],
      ...Object.entries(flags)
    ]),
    client: new RuntimeClient(root, 5_000, null, null, 'orca'),
    cwd: root,
    json: true
  })
}

function update(flags: Record<string, boolean>): Promise<void> {
  return run('environment update', flags)
}

describe('orca environment update --force', () => {
  it('never writes bare --force to a desktop that would give it full force', async () => {
    select(await startRuntime('legacy', LEGACY))

    await expect(update({ force: true })).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(routes()).toEqual([['legacy', 1, 'status.get']])
  })

  it('sends bare --force on the connection whose status advertised limited force', async () => {
    vi.stubEnv(RUNTIME_SOURCE_ID_ENV, 'source-a')
    vi.stubEnv(RUNTIME_SOURCE_INCARNATION_ENV, 'current')
    const legacy = await startRuntime('legacy', LEGACY)
    // The selected runtime changes while the capable one answers status.
    select(await startRuntime('current', CURRENT, { onStatus: () => select(legacy) }))

    await expect(update({ force: true })).rejects.toMatchObject({ code: 'managed_server_deferred' })
    expect(routes()).toEqual([
      ['current', 1, 'status.get'],
      ['current', 1, 'managedServer.update']
    ])
    expect(frames[1]!.params).toStrictEqual({ selector: 'build-box', force: true })
    // Both frames carry the capable runtime's own token and the same source fence.
    for (const frame of frames) {
      expect(frame.authToken).toBe('token-current')
      expect(frame.expectedRuntimeSource).toEqual({ sourceId: 'source-a', runtimeId: 'current' })
    }
  })

  it.each([
    ['legacy', LEGACY],
    ['current', CURRENT]
  ])(
    'keeps the ungated forms and rollback on their own two calls (%s desktop)',
    async (id, caps) => {
      select(await startRuntime(id, caps))
      const sent = (): unknown => frames.at(-1)!.params

      await expect(update({ force: true, yes: true })).rejects.toMatchObject({
        code: 'managed_server_deferred'
      })
      expect(sent()).toStrictEqual({
        selector: 'build-box',
        force: true,
        endInProcessTerminals: true
      })
      // Without force there is nothing to end, so neither form is gated.
      await expect(update({})).rejects.toMatchObject({ code: 'managed_server_deferred' })
      expect(sent()).toStrictEqual({ selector: 'build-box', force: false })
      await expect(update({ yes: true })).rejects.toMatchObject({ code: 'managed_server_deferred' })
      expect(sent()).toStrictEqual({ selector: 'build-box', force: false })
      await expect(run('environment rollback', {})).resolves.toBeUndefined()
      expect(sent()).toStrictEqual({ selector: 'build-box' })

      // Each action: a status read on one connection, then the action on the next.
      expect(routes()).toEqual(
        [
          'managedServer.update',
          'managedServer.update',
          'managedServer.update',
          'managedServer.rollback'
        ].flatMap((method, index) => [
          [id, index * 2 + 1, 'status.get'],
          [id, index * 2 + 2, method]
        ])
      )
    }
  )

  it.each([
    ['without managed servers', { result: { capabilities: [] } }, 'incompatible_runtime'],
    ['without a capability list', { result: {} }, 'incompatible_runtime'],
    [
      'with a malformed capability list',
      { result: { capabilities: 'all' } },
      'invalid_runtime_response'
    ]
  ] as const)('refuses a status %s without sending', async (_, status, code) => {
    select(await startRuntime('current', CURRENT, { status }))

    await expect(update({ force: true })).rejects.toMatchObject({ code })
    expect(routes()).toEqual([['current', 1, 'status.get']])
  })

  it('refuses as an older desktop when the accepted update itself is an unknown method', async () => {
    select(await startRuntime('current', CURRENT, { update: 'unknown-method' }))

    await expect(update({ force: true })).rejects.toMatchObject({ code: 'incompatible_runtime' })
    // Written once, and not treated as a restart.
    expect(routes()).toEqual([
      ['current', 1, 'status.get'],
      ['current', 1, 'managedServer.update']
    ])
  })

  it.each([
    ['answers status with an error', 'error', 'runtime_busy'],
    // Not the update's own method, so not the older-host refusal.
    ['does not know the status method', 'unknown-method', 'method_not_found'],
    ['closes before answering status', 'close', 'runtime_unavailable']
  ] as const)(
    'fails without sending or reporting a restart when the desktop %s',
    async (_, status, code) => {
      select(await startRuntime('current', CURRENT, { status }))

      await expect(update({ force: true })).rejects.toMatchObject({ code })
      // A recovery status read here would mean the CLI treated the unsent update as a restart.
      expect(routes()).toEqual([['current', 1, 'status.get']])
    }
  )

  it('fails without reporting a restart when no desktop profile is running', async () => {
    await expect(update({ force: true })).rejects.toMatchObject({ code: 'runtime_unavailable' })
    expect(frames).toEqual([])
  })

  it.each([
    ['cannot reach the desktop', 'close', 'runtime_unavailable'],
    ['times out', 'silent', 'runtime_timeout']
  ] as const)('fails without sending when the runtime source check %s', async (_, status, code) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv(RUNTIME_SOURCE_ID_ENV, 'source-a')
    vi.stubEnv(RUNTIME_SOURCE_INCARNATION_ENV, 'an-earlier-runtime')
    select(await startRuntime('current', CURRENT, { status }))

    const failed = expect(update({ force: true })).rejects.toMatchObject({ code })
    await vi.waitFor(() => expect(methods()).toEqual(['status.get']))
    // The probe keeps the client's own budget.
    await vi.advanceTimersByTimeAsync(5_000)
    await failed
    // Only the fence's own probe; neither the selection status nor the update followed.
    expect(methods()).toEqual(['status.get'])
  })

  it('reports from status once a written update loses its connection, without resending it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    select(await startRuntime('current', CURRENT, { update: 'close' }))

    const reported = update({ force: true })
    await vi.waitFor(() => expect(methods()).toContain('managedServer.update'))
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(reported).resolves.toBeUndefined()
    expect(methods()).toEqual(['status.get', 'managedServer.update', 'managedServer.status'])
  })

  it('gives the status a short budget and never sends after a late status', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let holdStatus!: (reply: () => void) => void
    const statusHeld = new Promise<() => void>((done) => (holdStatus = done))
    select(await startRuntime('current', CURRENT, { status: { hold: holdStatus } }))

    const late = expect(update({ force: true })).rejects.toMatchObject({ code: 'runtime_timeout' })
    const answerStatus = await statusHeld
    await vi.advanceTimersByTimeAsync(60_000)
    await late
    answerStatus()
    await vi.advanceTimersByTimeAsync(0)
    expect(methods()).toEqual(['status.get'])
  })

  it('gives an accepted update the full action budget, not what was left of the status one', async () => {
    // Date too, so a budget measured from connect by the clock is caught as well.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let holdStatus!: (reply: () => void) => void
    const statusHeld = new Promise<() => void>((done) => (holdStatus = done))
    let holdUpdate!: (reply: () => void) => void
    const updateHeld = new Promise<() => void>((done) => (holdUpdate = done))
    select(await startRuntime('slow', CURRENT, { status: { hold: holdStatus }, holdUpdate }))

    const slow = expect(update({ force: true })).rejects.toMatchObject({
      code: 'managed_server_deferred'
    })
    // Status accepted just inside its own budget.
    const answerStatus = await statusHeld
    await vi.advanceTimersByTimeAsync(59_000)
    answerStatus()
    const replyToUpdate = await updateHeld
    // Quiet past the status budget, and past 20 minutes from connect, but inside 20 from acceptance.
    await vi.advanceTimersByTimeAsync(19 * 60_000 + 30_000)
    replyToUpdate()
    await slow

    frames = []
    select(await startRuntime('stalled', CURRENT, { update: 'silent' }))
    const stalled = expect(update({ force: true })).rejects.toMatchObject({
      code: 'managed_server_in_progress'
    })
    await vi.waitFor(() => expect(methods()).toContain('managedServer.update'))
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    await stalled
    expect(methods()).toEqual(['status.get', 'managedServer.update'])
  })
})
