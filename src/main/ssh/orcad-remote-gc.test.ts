import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-gc-claim', () => ({
  isRelayGcClaimOwned: vi.fn().mockResolvedValue(true),
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('token')
}))
vi.mock('./ssh-relay-gc-tombstone', () => ({
  cleanupRelayGcTombstones: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-install-lock', () => ({
  RELAY_INSTALL_LOCK_NAME: '.install-lock',
  isRelayInstallLockStale: vi.fn().mockResolvedValue(false)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { gcOldOrcadVersions } from './orcad-remote-gc'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const mockExec = vi.mocked(execCommand)

/**
 * Drive one GC pass against a scripted host. `listing` is what the remote listing command
 * returns; every other command answers from `responses`, defaulting to the happy path
 * (unlocked, complete, dead) so a candidate is removed unless a test says otherwise.
 */
function scriptHost(options: {
  listing: string[]
  liveness?: Record<string, 'LIVE' | 'DEAD' | 'UNKNOWN'>
  removed: string[]
}): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    if (command.includes('-mindepth 1 -maxdepth 1')) {
      return options.listing.join('\n')
    }
    if (command.includes('.install-lock')) {
      return 'OPEN'
    }
    if (command.includes('.install-complete')) {
      return 'COMPLETE'
    }
    if (command.includes('.orcad-pid')) {
      const dir = Object.keys(options.liveness ?? {}).find((name) => command.includes(name))
      return dir ? (options.liveness?.[dir] ?? 'DEAD') : 'DEAD'
    }
    if (command.startsWith('mv ')) {
      const match = command.match(/'([^']*)'/)
      if (match) {
        options.removed.push(match[1].split('/').pop() ?? '')
      }
      return 'MOVED'
    }
    return ''
  })
}

describe('orcad GC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopes its remote listing to the orcad namespace', async () => {
    const removed: string[] = []
    scriptHost({ listing: [], removed })
    await gcOldOrcadVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.orca-remote/orcad-0.2.0+bb',
      record: emptyOrcadActivationRecord()
    })
    const listCommand = mockExec.mock.calls.map((call) => String(call[1])).find((c) => c.includes('find'))
    expect(listCommand).toContain("-name 'orcad-*'")
    expect(listCommand).not.toContain("-name 'relay-*'")
  })

  it('leaves relay directories alone even when the host hands them to it', async () => {
    // The host is lying — or a future listing bug widened the glob. GC must still refuse.
    const removed: string[] = []
    scriptHost({
      listing: ['relay-0.1.0+aa', 'relay-0.0.9+ff', 'orcad-0.1.0+aa'],
      removed
    })
    await gcOldOrcadVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.orca-remote/orcad-0.2.0+bb',
      record: emptyOrcadActivationRecord()
    })
    expect(removed).toEqual(['orcad-0.1.0+aa'])
  })

  it('never removes the active or the previous version', async () => {
    const removed: string[] = []
    scriptHost({
      listing: ['orcad-0.1.0+01d', 'orcad-0.2.0+9ee0', 'orcad-0.3.0+cc0'],
      removed
    })
    await gcOldOrcadVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.orca-remote/orcad-0.3.0+cc0',
      record: {
        ...emptyOrcadActivationRecord(),
        active: '0.3.0+cc0',
        previous: '0.2.0+9ee0'
      }
    })
    expect(removed).toEqual(['orcad-0.1.0+01d'])
  })

  it('never removes the version a live daemon was forked from', async () => {
    const removed: string[] = []
    scriptHost({ listing: ['orcad-0.1.0+01d', 'orcad-0.0.9+01de'], removed })
    await gcOldOrcadVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.orca-remote/orcad-0.3.0+cc0',
      record: { ...emptyOrcadActivationRecord(), active: '0.3.0+cc0' },
      liveDaemonVersion: '0.1.0+01d'
    })
    expect(removed).toEqual(['orcad-0.0.9+01de'])
  })

  it('treats an unanswerable liveness probe as in use', async () => {
    const removed: string[] = []
    scriptHost({
      listing: ['orcad-0.1.0+bb0', 'orcad-0.0.9+dead'],
      liveness: { 'orcad-0.1.0+bb0': 'UNKNOWN', 'orcad-0.0.9+dead': 'DEAD' },
      removed
    })
    await gcOldOrcadVersions({
      conn,
      host,
      remoteHome: '/home/u',
      currentDirAbsPath: '/home/u/.orca-remote/orcad-0.3.0+cc0',
      record: emptyOrcadActivationRecord()
    })
    expect(removed).toEqual(['orcad-0.0.9+dead'])
  })
})
