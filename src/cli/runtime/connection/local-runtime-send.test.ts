import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { getRuntimeRestartMarkerPath } from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { sendLocalRuntimeRequest, type LocalRuntimeRequest } from './local-runtime-send'
import { RuntimeRestartWait } from './runtime-restart-wait'
import { createRuntimeSourceFence } from './runtime-source-fence'
import { RuntimeClientError } from './types'

// A pid that has exited, so the runtime it names is not running.
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid
const RECOVERED = new Error('recovered')

let profile = ''

beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), 'orca-local-send-'))
})

afterEach(async () => {
  await rm(profile, { recursive: true, force: true })
})

/** Metadata naming a socket nothing listens on, so the request's own dial is refused. */
async function writeMetadata(runtimeId = 'rt-1'): Promise<void> {
  await writeFile(
    getRuntimeMetadataPath(profile),
    JSON.stringify({
      runtimeId,
      pid: DEAD_PID,
      authToken: 'fixture',
      startedAt: Date.now(),
      transports: [{ kind: 'unix', endpoint: join(profile, 'absent.sock') }]
    }),
    { mode: 0o600 }
  )
}

/** A restart marker past its overdue point whose quitting process has gone. */
async function writeOverdueRestart(): Promise<void> {
  await writeFile(
    getRuntimeRestartMarkerPath(profile),
    JSON.stringify({ reason: 'relaunch', writtenAt: Date.now() - 60_000, pid: DEAD_PID })
  )
}

function request(overrides: Partial<LocalRuntimeRequest>) {
  const recover = vi.fn((_error: unknown, _runtimeId: string | null): unknown => RECOVERED)
  return {
    recover,
    request: {
      userDataPath: profile,
      fence: createRuntimeSourceFence({}, profile, 1_000),
      restartWait: new RuntimeRestartWait(profile, { sleep: async () => {} }),
      method: 'orchestration.send',
      params: { type: 'worker_done' },
      timeoutMs: 1_000,
      envelope: { orchestrationRequestId: 'mutation_1' },
      recover,
      ...overrides
    } satisfies LocalRuntimeRequest
  }
}

const BRANCHES: [string, () => Promise<Partial<LocalRuntimeRequest>>, RegExp][] = [
  [
    'a dead runtime process',
    async () => {
      await writeMetadata()
      return {}
    },
    /not running/
  ],
  [
    'an overdue restart',
    async () => {
      await writeMetadata()
      await writeOverdueRestart()
      return {}
    },
    /restarted \d+ s ago/
  ],
  [
    'a runtime replaced since the preflight',
    async () => {
      await writeMetadata('rt-2')
      return { pinnedRuntimeId: 'rt-1' }
    },
    /restarted while this command was running/
  ],
  ['missing runtime metadata', async () => ({}), /metadata/]
]

describe('a local request refused before its frame is written', () => {
  it.each(BRANCHES)(
    'recovers an orchestration request after %s, marked unsent',
    async (_case, arrange, message) => {
      const { request: sent, recover } = request({ ...(await arrange()), recoverUnsent: true })

      await expect(sendLocalRuntimeRequest(sent)).rejects.toBe(RECOVERED)

      expect(recover).toHaveBeenCalledTimes(1)
      const [error] = recover.mock.calls[0] ?? []
      expect(error).toBeInstanceOf(RuntimeClientError)
      expect(error).toMatchObject({ code: 'runtime_unavailable', data: { requestSent: false } })
      expect(error instanceof Error ? error.message : '').toMatch(message)
    }
  )

  it.each(
    BRANCHES.flatMap(([name, arrange, message]) => [
      [`${name}, flag omitted`, arrange, message, undefined],
      [`${name}, flag false`, arrange, message, false]
    ])
  )('leaves any other request bare after %s', async (_case, arrange, message, recoverUnsent) => {
    const overrides = await arrange()
    const { request: sent, recover } = request(
      recoverUnsent === undefined ? overrides : { ...overrides, recoverUnsent }
    )

    const error = await sendLocalRuntimeRequest(sent).catch((caught: unknown) => caught)

    expect(recover).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(RuntimeClientError)
    expect(error).toMatchObject({ code: 'runtime_unavailable' })
    expect(error).not.toHaveProperty('data.orchestrationRequestId')
    expect(error instanceof Error ? error.message : '').toMatch(message)
  })
})
