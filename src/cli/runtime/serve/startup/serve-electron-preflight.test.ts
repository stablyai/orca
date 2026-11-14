import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../../../shared/runtime-bootstrap'
import { readServeAbortPark } from '../../../../shared/serve-abort-park'
import { preflightElectronServe, recordElectronServeStartupAbort } from './serve-electron-preflight'
import * as metadataReader from '../../profile/metadata'
import { RuntimeClientError } from '../../connection/types'

vi.mock('../../profile/metadata', async (original) => {
  const actual = await original<typeof metadataReader>()
  return { ...actual, tryReadMetadata: vi.fn(actual.tryReadMetadata) }
})

let actualMetadata: typeof metadataReader
beforeAll(async () => {
  actualMetadata = await vi.importActual<typeof metadataReader>('../../profile/metadata')
})

const METADATA: RuntimeMetadata = {
  runtimeId: 'runtime-1',
  pid: 4242,
  transports: [{ kind: 'unix', endpoint: '/tmp/orca-test.sock' }],
  authToken: 'token',
  startedAt: 1
}

function status(reachable: boolean, pid: number | null = 4242) {
  return { reachable, legacyPidRunning: reachable, pid }
}

describe('preflightElectronServe', () => {
  let userData: string
  let stdout: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-serve-preflight-'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function deps(
    overrides: {
      metadata?: RuntimeMetadata | null
      reachable?: boolean
      probe?: 'accepting' | 'not-listening' | 'unproven'
      statusError?: Error
    } = {}
  ) {
    return {
      readMetadata: () => (overrides.metadata === undefined ? METADATA : overrides.metadata),
      readAdmission: vi.fn(async () => {
        if (overrides.statusError) {
          throw overrides.statusError
        }
        return status(overrides.reachable ?? false)
      }),
      probeListener: vi.fn(async () => overrides.probe ?? 'not-listening')
    }
  }

  it('prints the refusal as a JSON envelope for --json callers', async () => {
    await preflightElectronServe({ json: true }, userData, {
      platform: 'linux',
      deps: deps({ reachable: true })
    })
    const envelope = JSON.parse(String(stdout.mock.calls[0]?.[0]))
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'runtime_serve_already_running', data: { verdict: 'live', pid: 4242 } }
    })
  })

  it('treats an accepting socket as live and an unanswered one as unverifiable, both refused', async () => {
    await expect(
      preflightElectronServe({}, userData, {
        platform: 'linux',
        deps: deps({ probe: 'accepting' })
      })
    ).resolves.toBe(3)
    await expect(
      preflightElectronServe({}, userData, { platform: 'linux', deps: deps({ probe: 'unproven' }) })
    ).resolves.toBe(3)
  })

  it('treats a denied status check as unverifiable, not as stopped', async () => {
    const denied = new RuntimeClientError('runtime_access_denied', 'denied')
    await expect(
      preflightElectronServe({}, userData, {
        platform: 'linux',
        deps: deps({ statusError: denied })
      })
    ).resolves.toBe(3)
  })

  describe('remembered macOS startup abort', () => {
    const fingerprint = () => 'Background|ssh=1|sandbox=0'

    it('refuses a later run from the same environment with exit 78 before anything else', () => {
      recordElectronServeStartupAbort(userData, 'Orca serve aborted with SIGABRT on macOS.', {
        now: 1_000,
        fingerprint
      })
      const result = preflightElectronServe({}, userData, {
        platform: 'darwin',
        now: 1_000 + 5 * 60_000,
        fingerprint,
        deps: deps({ metadata: null })
      })
      expect(result).toBe(78)
    })

    it('lets a different environment, an expired park, or --force through', () => {
      recordElectronServeStartupAbort(userData, 'aborted', { now: 1_000, fingerprint })
      const run = (args: { force?: boolean }, now: number, print = fingerprint) =>
        preflightElectronServe(args, userData, {
          platform: 'darwin',
          now,
          fingerprint: print,
          deps: deps({ metadata: null })
        })
      expect(run({}, 2_000, () => 'Aqua|ssh=0|sandbox=0')).toBeNull()
      expect(run({}, 1_000 + 31 * 60_000)).toBeNull()
      expect(run({ force: true }, 2_000)).toBeNull()
      expect(readServeAbortPark(userData)).toBeNull()
    })
  })
})

// Real bootstrap/transport/listener coverage of the default admission dependency.
describe.skipIf(process.platform === 'win32')('serve private admission snapshots', () => {
  let root: string
  let server: ReturnType<typeof createServer> | undefined
  const sockets = new Set<Socket>()
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-serve-admission-'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
    if (server) {
      const listening = server
      await new Promise<void>((resolve) => listening.close(() => resolve()))
    }
    server = undefined
    vi.restoreAllMocks()
    vi.mocked(metadataReader.tryReadMetadata).mockReset()
    vi.mocked(metadataReader.tryReadMetadata).mockImplementation(actualMetadata.tryReadMetadata)
    rmSync(root, { recursive: true, force: true })
  })
  function publish(pid = 2147483647, endpoint = join(root, 'runtime.sock')) {
    const metadata = { ...METADATA, pid, transports: [{ kind: 'unix', endpoint }] }
    writeFileSync(join(root, 'orca-runtime.json'), JSON.stringify(metadata))
    return metadata
  }
  it.each([2147483647, process.pid])(
    'retains launch permission for absent listener even with PID %s',
    async (pid) => {
      publish(pid)
      await expect(preflightElectronServe({}, root, { platform: 'linux' })).resolves.toBeNull()
    }
  )
  it.each(['disappeared', 'replacement', 'incomplete'])(
    'probes original M0 listener after M1 %s',
    async (change) => {
      const first = publish()
      const listener = createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.resume()
      })
      server = listener
      await new Promise<void>((resolve) => listener.listen(first.transports[0].endpoint, resolve))
      vi.mocked(metadataReader.tryReadMetadata).mockImplementationOnce((path) => {
        const m0 = actualMetadata.tryReadMetadata(path)
        if (change === 'disappeared') {
          unlinkSync(join(root, 'orca-runtime.json'))
        } else {
          publish(process.pid, join(root, 'new.sock'))
          if (change === 'incomplete') {
            writeFileSync(
              join(root, 'orca-runtime.json'),
              JSON.stringify({ ...first, authToken: null })
            )
          }
        }
        return m0
      })
      await expect(preflightElectronServe({}, root, { platform: 'linux' })).resolves.toBe(3)
    }
  )
})
