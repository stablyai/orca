import { createServer, type Server } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
} from '../../shared/runtime-source-env'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import { resolveFencedRuntimeSource } from './runtime-source-fence'

const SOURCE_A = '11111111-1111-4111-8111-111111111111'
const SOURCE_B = '22222222-2222-4222-8222-222222222222'

const servers = new Set<Server>()
const savedEnv = {
  id: process.env[RUNTIME_SOURCE_ID_ENV],
  incarnation: process.env[RUNTIME_SOURCE_INCARNATION_ENV],
  profilePath: process.env[RUNTIME_SOURCE_PROFILE_PATH_ENV]
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(async () => {
  restoreEnv(RUNTIME_SOURCE_ID_ENV, savedEnv.id)
  restoreEnv(RUNTIME_SOURCE_INCARNATION_ENV, savedEnv.incarnation)
  restoreEnv(RUNTIME_SOURCE_PROFILE_PATH_ENV, savedEnv.profilePath)
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
})

type FakeRuntime = { userDataPath: string; methods: string[]; expectations: unknown[] }

/** A live runtime on its own socket that answers every method and records what reached it. */
async function startRuntime(args: {
  runtimeId: string
  installationId?: string
}): Promise<FakeRuntime> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-source-fence-'))
  const isWindows = process.platform === 'win32'
  const endpoint = isWindows
    ? `\\\\.\\pipe\\orca-source-fence-${randomUUID()}`
    : join(userDataPath, 'runtime.sock')
  const methods: string[] = []
  const expectations: unknown[] = []
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      const request: { id: string; method: string; expectedRuntimeSource?: unknown } = JSON.parse(
        buffer.slice(0, newline)
      )
      methods.push(request.method)
      expectations.push(request.expectedRuntimeSource)
      const result =
        request.method === 'status.get'
          ? {
              runtimeId: args.runtimeId,
              ...(args.installationId
                ? { hostDescriptor: { installationId: args.installationId } }
                : {})
            }
          : { ok: true }
      socket.end(
        `${JSON.stringify({ id: request.id, ok: true, result, _meta: { runtimeId: args.runtimeId } })}\n`
      )
    })
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  writeFileSync(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: args.runtimeId,
      pid: 1,
      transports: [{ kind: isWindows ? 'named-pipe' : 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    })
  )
  return { userDataPath, methods, expectations }
}

function launchedBy(sourceId: string, incarnation: string, profilePath?: string): void {
  process.env[RUNTIME_SOURCE_ID_ENV] = sourceId
  process.env[RUNTIME_SOURCE_INCARNATION_ENV] = incarnation
  restoreEnv(RUNTIME_SOURCE_PROFILE_PATH_ENV, profilePath)
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(RuntimeClientError)
  expect(error).toMatchObject({ code })
}

describe('RuntimeClient runtime-source fence', () => {
  it('refuses another live runtime before the request reaches it', async () => {
    const runtime = await startRuntime({ runtimeId: 'runtime-b', installationId: SOURCE_B })
    launchedBy(SOURCE_A, 'runtime-a')
    const client = new RuntimeClient(runtime.userDataPath, 2_000, null, null, 'orca')

    await expectRefusal(
      client.call('terminal.send', { terminal: 't1', text: 'hi' }),
      'runtime_source_mismatch'
    )
    await expectRefusal(client.call('worktree.list'), 'runtime_source_mismatch')
    expect(runtime.methods).toEqual(['status.get', 'status.get'])
  })

  it('accepts a restarted runtime of the same source and probes it only once', async () => {
    const runtime = await startRuntime({ runtimeId: 'runtime-a2', installationId: SOURCE_A })
    launchedBy(SOURCE_A, 'runtime-a1')
    const client = new RuntimeClient(runtime.userDataPath, 2_000, null, null, 'orca')

    await client.call('terminal.send', { terminal: 't1', text: 'hi' })
    await client.call('worktree.list')
    expect(runtime.methods).toEqual(['status.get', 'terminal.send', 'worktree.list'])
    // Why: the host refuses the send itself if it is no longer the runtime the probe verified.
    const expected = { sourceId: SOURCE_A, runtimeId: 'runtime-a2' }
    expect(runtime.expectations).toEqual([undefined, expected, expected])
  })

  it('sends without a probe when the launching runtime is still the live one', async () => {
    const runtime = await startRuntime({ runtimeId: 'runtime-a', installationId: SOURCE_A })
    launchedBy(SOURCE_A, 'runtime-a')
    const client = new RuntimeClient(runtime.userDataPath, 2_000, null, null, 'orca')

    await client.call('worktree.list')
    expect(runtime.methods).toEqual(['worktree.list'])
    expect(runtime.expectations).toEqual([{ sourceId: SOURCE_A, runtimeId: 'runtime-a' }])
  })

  it('refuses when the live runtime cannot say which profile it serves', async () => {
    const runtime = await startRuntime({ runtimeId: 'runtime-old' })
    launchedBy(SOURCE_A, 'runtime-a')
    const client = new RuntimeClient(runtime.userDataPath, 2_000, null, null, 'orca')

    await expectRefusal(client.call('worktree.list'), 'runtime_source_unverifiable')
    expect(runtime.methods).toEqual(['status.get'])
  })

  it('keeps the unfenced path for a CLI started outside an Orca terminal', async () => {
    const runtime = await startRuntime({ runtimeId: 'runtime-b', installationId: SOURCE_B })
    delete process.env[RUNTIME_SOURCE_ID_ENV]
    delete process.env[RUNTIME_SOURCE_INCARNATION_ENV]
    const client = new RuntimeClient(runtime.userDataPath, 2_000, null, null, 'orca')

    await client.call('worktree.list')
    expect(runtime.methods).toEqual(['worktree.list'])
    expect(runtime.expectations).toEqual([undefined])
  })

  it('lets an explicit switch to another profile through, e.g. orca-dev from a packaged terminal', async () => {
    const runtime = await startRuntime({ runtimeId: 'runtime-dev', installationId: SOURCE_B })
    launchedBy(SOURCE_A, 'runtime-a', join(tmpdir(), 'orca-packaged-profile'))
    const client = new RuntimeClient(runtime.userDataPath, 2_000, null, null, 'orca')

    await client.call('worktree.list')
    expect(runtime.methods).toEqual(['worktree.list'])
  })

  it('still fences a terminal whose CLI fell back to the platform default profile', () => {
    const stamp = { sourceId: SOURCE_A, incarnation: 'runtime-a', profilePath: '/profiles/custom' }
    expect(resolveFencedRuntimeSource(stamp, '/profiles/default', '/profiles/default')).toBe(stamp)
    expect(resolveFencedRuntimeSource(stamp, '/profiles/custom', '/profiles/default')).toBe(stamp)
    expect(resolveFencedRuntimeSource(stamp, '/profiles/dev', '/profiles/default')).toBeNull()
  })
})
