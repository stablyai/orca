import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EndpointProbeModule from '../../../endpoint/publication/daemon-endpoint-probe'

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
vi.mock('../../../endpoint/identity/daemon-pid-identity', () => ({
  inspectDaemonProcessIdentity: probes.identity
}))
vi.mock('../../../endpoint/publication/daemon-endpoint-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointProbeModule>()),
  probeSocketConnect: probes.endpoint
}))
vi.mock('../../../launch/daemon-stale-kill', () => ({ killStaleDaemon: probes.kill }))

import {
  discoverNewerProtocolHolds,
  isHoldingForNewerProtocolDaemon,
  reopenNewerDaemonTerminals
} from '../daemon-newer-protocol-hold'
import { getDaemonPidPath } from '../../../launch/daemon-spawner'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'

const NEWER = PROTOCOL_VERSION + 1
let runtimeDir: string
let otherProfileDir: string

function writePid(dir: string, protocolVersion: number, contents: string): void {
  writeFileSync(getDaemonPidPath(dir, protocolVersion), contents)
}

const RECORD = JSON.stringify({ pid: 42, startedAtMs: 1_700_000_000_000, launchNonce: 'n' })

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
})
