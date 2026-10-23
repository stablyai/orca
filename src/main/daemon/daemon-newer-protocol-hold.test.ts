import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EndpointProbeModule from './daemon-endpoint-probe'

const probes = vi.hoisted(() => ({
  identity: vi.fn<(pid: number, socketPath: string) => Promise<'match' | 'mismatch' | 'unknown'>>(),
  endpoint:
    vi.fn<(socketPath: string) => Promise<'connected' | 'missing' | 'refused' | 'unknown'>>(),
  kill: vi.fn<
    (
      runtimeDir: string,
      socketPath: string,
      tokenPath: string,
      protocolVersion: number
    ) => Promise<{ killed: boolean; liveOwnerSurvived: boolean }>
  >()
}))
vi.mock('./daemon-pid-identity', () => ({ inspectDaemonProcessIdentity: probes.identity }))
vi.mock('./daemon-endpoint-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointProbeModule>()),
  probeSocketConnect: probes.endpoint
}))
vi.mock('./daemon-stale-kill', () => ({ killStaleDaemon: probes.kill }))

import {
  discoverNewerProtocolHolds,
  isHoldingForNewerProtocolDaemon,
  readNewerDaemonHeldScreen,
  reopenNewerDaemonTerminals
} from './daemon-newer-protocol-hold'
import { getDaemonPidPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

const NEWER = PROTOCOL_VERSION + 1
let runtimeDir: string
let otherProfileDir: string

function writePid(dir: string, protocolVersion: number, contents: string): void {
  writeFileSync(getDaemonPidPath(dir, protocolVersion), contents)
}

const RECORD = JSON.stringify({ pid: 42, startedAtMs: 1_700_000_000_000, launchNonce: 'n' })

async function holds(): Promise<boolean> {
  await discoverNewerProtocolHolds(runtimeDir)
  return isHoldingForNewerProtocolDaemon()
}

beforeEach(async () => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(join(tmpdir(), 'orca-newer-daemon-'))
  otherProfileDir = mkdtempSync(join(tmpdir(), 'orca-newer-daemon-other-'))
  probes.identity.mockResolvedValue('match')
  probes.endpoint.mockResolvedValue('connected')
  probes.kill.mockResolvedValue({ killed: true, liveOwnerSurvived: false })
  await discoverNewerProtocolHolds(runtimeDir)
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(otherProfileDir, { recursive: true, force: true })
})

describe('discoverNewerProtocolHolds', () => {
  it('holds nothing for this and older protocols, or another profile', async () => {
    writePid(runtimeDir, PROTOCOL_VERSION, RECORD)
    writePid(runtimeDir, PROTOCOL_VERSION - 1, RECORD)
    writePid(otherProfileDir, NEWER, RECORD)
    await expect(holds()).resolves.toBe(false)
    expect(probes.identity).not.toHaveBeenCalled()
  })

  it('holds for a verified newer daemon', async () => {
    writePid(runtimeDir, NEWER, RECORD)
    await expect(holds()).resolves.toBe(true)
    expect(probes.identity).toHaveBeenCalledWith(
      42,
      expect.stringContaining(`v${NEWER}`),
      expect.stringContaining(`v${NEWER}`),
      1_700_000_000_000
    )
  })

  it('holds nothing for a gone or recycled pid and leaves the newer files alone', async () => {
    probes.identity.mockResolvedValue('mismatch')
    writePid(runtimeDir, NEWER, RECORD)
    writeFileSync(join(runtimeDir, `daemon-v${NEWER}.token`), 'secret')
    await expect(holds()).resolves.toBe(false)
    expect(readdirSync(runtimeDir).sort()).toEqual([
      `daemon-v${NEWER}.pid`,
      `daemon-v${NEWER}.token`
    ])
    expect(readFileSync(getDaemonPidPath(runtimeDir, NEWER), 'utf8')).toBe(RECORD)
  })

  it.each([
    ['connected', true],
    ['unknown', true],
    ['refused', false],
    ['missing', false]
  ] as const)(
    'settles an unidentifiable owner by its endpoint (%s holds: %s)',
    async (endpoint, expected) => {
      probes.identity.mockResolvedValue('unknown')
      probes.endpoint.mockResolvedValue(endpoint)
      writePid(runtimeDir, NEWER, RECORD)
      await expect(holds()).resolves.toBe(expected)
    }
  )

  it('re-probes a timed-out endpoint once before holding', async () => {
    probes.identity.mockResolvedValue('unknown')
    probes.endpoint.mockResolvedValueOnce('unknown').mockResolvedValueOnce('refused')
    writePid(runtimeDir, NEWER, RECORD)
    await expect(holds()).resolves.toBe(false)
    expect(probes.endpoint).toHaveBeenCalledTimes(2)
  })

  it.each(['', '{"pid":4242,"startedAt', 'not a record'])(
    'never holds forever on an unparseable record %j',
    async (contents) => {
      writePid(runtimeDir, NEWER, contents)
      probes.endpoint.mockResolvedValue('missing')
      await expect(holds()).resolves.toBe(false)
      probes.endpoint.mockResolvedValue('connected')
      await expect(holds()).resolves.toBe(true)
      expect(probes.identity).not.toHaveBeenCalled()
    }
  )
})

describe('reopenNewerDaemonTerminals', () => {
  beforeEach(async () => {
    writePid(runtimeDir, NEWER, RECORD)
    await discoverNewerProtocolHolds(runtimeDir)
  })

  it('releases once the verified daemon is stopped and reads exited', async () => {
    probes.kill.mockImplementation(async () => {
      rmSync(getDaemonPidPath(runtimeDir, NEWER))
      return { killed: true, liveOwnerSurvived: false }
    })
    await expect(reopenNewerDaemonTerminals(runtimeDir)).resolves.toEqual({ reopened: true })
    expect(probes.kill).toHaveBeenCalledWith(
      runtimeDir,
      expect.stringContaining(`v${NEWER}`),
      join(runtimeDir, `daemon-v${NEWER}.token`),
      NEWER
    )
    expect(isHoldingForNewerProtocolDaemon()).toBe(false)
  })

  it('reopens nothing when the daemon survives or still reads live', async () => {
    probes.kill.mockResolvedValueOnce({ killed: false, liveOwnerSurvived: true })
    await expect(reopenNewerDaemonTerminals(runtimeDir)).resolves.toEqual({ reopened: false })
    await expect(reopenNewerDaemonTerminals(runtimeDir)).resolves.toEqual({ reopened: false })
    expect(isHoldingForNewerProtocolDaemon()).toBe(true)
  })

  it('never signals an owner it cannot identify while its endpoint answers', async () => {
    probes.identity.mockResolvedValue('unknown')
    await expect(reopenNewerDaemonTerminals(runtimeDir)).resolves.toEqual({ reopened: false })
    expect(probes.kill).not.toHaveBeenCalled()
  })

  it('releases an unidentifiable owner whose endpoint is dead, without signalling', async () => {
    probes.identity.mockResolvedValue('unknown')
    probes.endpoint.mockResolvedValue('refused')
    await expect(reopenNewerDaemonTerminals(runtimeDir)).resolves.toEqual({ reopened: true })
    expect(probes.kill).not.toHaveBeenCalled()
  })

  it('shares one stop between concurrent clicks', async () => {
    probes.identity.mockResolvedValueOnce('match').mockResolvedValue('mismatch')
    const results = await Promise.all([
      reopenNewerDaemonTerminals(runtimeDir),
      reopenNewerDaemonTerminals(runtimeDir)
    ])
    expect(results).toEqual([{ reopened: true }, { reopened: true }])
    expect(probes.kill).toHaveBeenCalledTimes(1)
  })
})

describe('readNewerDaemonHeldScreen', () => {
  it('reads nothing for a session with no saved history', async () => {
    await expect(readNewerDaemonHeldScreen('s1', runtimeDir)).resolves.toBeNull()
  })
})
