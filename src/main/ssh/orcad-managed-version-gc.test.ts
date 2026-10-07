import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServeReadiness } from '../server/serve-readiness'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'

const { gcMock, readRecordMock } = vi.hoisted(() => ({
  gcMock: vi.fn(),
  readRecordMock: vi.fn()
}))

vi.mock('./orcad-remote-gc', () => ({ gcOldOrcadVersions: gcMock }))
vi.mock('./orcad-activation-record-store', () => ({ readOrcadActivationRecord: readRecordMock }))

import { provenLiveDaemonVersion, pruneManagedOrcadVersions } from './orcad-managed-version-gc'

function readiness(terminalDaemon: unknown): ServeReadiness {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health.terminalDaemon is read.
  return { health: terminalDaemon === undefined ? undefined : { terminalDaemon } } as ServeReadiness
}

const slot = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: GC is mocked and never touches the connection.
  conn: {} as never,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: GC is mocked; the slot's host is only passed through.
  host: { os: 'linux', pathFlavor: 'posix', commandDialect: 'posix' } as never,
  remoteHome: '/home/u',
  nodePath: 'node',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 0
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('managed orcad version GC after a deploy', () => {
  it('pins only a daemon version the readiness proves', () => {
    expect(provenLiveDaemonVersion(readiness({ state: 'live', buildVersion: '1.0.0+a' }))).toBe(
      '1.0.0+a'
    )
    expect(provenLiveDaemonVersion(readiness({ state: 'absent', buildVersion: null }))).toBeNull()
    expect(
      provenLiveDaemonVersion(readiness({ state: 'degraded', buildVersion: '1' }))
    ).toBeUndefined()
    expect(
      provenLiveDaemonVersion(readiness({ state: 'live', buildVersion: null }))
    ).toBeUndefined()
    expect(provenLiveDaemonVersion(readiness(undefined))).toBeUndefined()
  })

  it('runs GC with the live daemon pinned, and keeps everything when it cannot say', async () => {
    readRecordMock.mockResolvedValue({ active: '2.0.0+b' })
    await pruneManagedOrcadVersions({
      slot,
      serverTarget: 'linux-x64-glibc',
      activeVersion: '2.0.0+b',
      readiness: readiness({ state: 'live', buildVersion: '1.0.0+a' })
    })
    expect(gcMock).toHaveBeenCalledWith(
      expect.objectContaining({
        liveDaemonVersion: '1.0.0+a',
        record: { active: '2.0.0+b' },
        // The compat runtime stays pinned: a compat orcad and a rung A relay share the store.
        nodeRuntimePins: [
          NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256,
          NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256
        ]
      })
    )

    gcMock.mockClear()
    await pruneManagedOrcadVersions({
      slot,
      serverTarget: 'linux-x64-glibc',
      activeVersion: '2.0.0+b',
      readiness: readiness({ state: 'degraded', buildVersion: null })
    })
    expect(gcMock).not.toHaveBeenCalled()
  })

  it('never fails the deploy it follows', async () => {
    readRecordMock.mockResolvedValue({ active: '2.0.0+b' })
    gcMock.mockRejectedValue(new Error('ssh dropped'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(
      pruneManagedOrcadVersions({
        slot,
        serverTarget: 'linux-x64-glibc',
        activeVersion: '2.0.0+b',
        readiness: readiness({ state: 'absent', buildVersion: null })
      })
    ).resolves.toBeUndefined()
  })
})
