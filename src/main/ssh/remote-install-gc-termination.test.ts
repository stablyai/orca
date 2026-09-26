import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn()
}))

import type { SshConnection } from './ssh-connection'
import { gcOldRelayVersions } from './remote-install-gc'
import { execCommand } from './ssh-relay-deploy-helpers'
import { gcRelayNativeDepsCache } from './ssh-relay-native-deps-cache-gc'
import { gcRemoteRipgrepCache } from './ssh-relay-ripgrep-cache-gc'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all connection access is replaced by execCommand's mock.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const home = '/home/u'
const currentDir = `${home}/.orca-remote/relay-0.1.0+bbb`
const nativeKey = 'linux-x64-0123456789abcdef'
const mockExec = vi.mocked(execCommand)

beforeEach(() => {
  mockExec.mockReset()
  mockExec.mockResolvedValue('')
})

function failAfter(replies: readonly string[], confirmed = false): Error {
  for (const reply of replies) {
    mockExec.mockResolvedValueOnce(reply)
  }
  const error = Object.assign(new Error('SSH command timed out'), {
    sshChannelCloseConfirmed: confirmed
  })
  mockExec.mockRejectedValueOnce(error)
  return error
}

function collectRelayVersions(): Promise<void> {
  return gcOldRelayVersions(conn, home, currentDir, host, { nativeDepsCacheKeys: [nativeKey] })
}

const versionSteps = [
  ['listing', 'relay-0.1.0+aaa\nrelay-0.1.0+ccc'],
  ['install lock probe', 'OPEN'],
  ['completion probe', 'COMPLETE'],
  ['liveness probe', 'DEAD'],
  ['claim acquisition', 'OK'],
  ['claim owner write', ''],
  ['claimed install lock probe', 'OPEN'],
  ['claimed completion probe', 'COMPLETE'],
  ['claimed liveness probe', 'DEAD'],
  ['claim ownership probe', 'OWNED'],
  ['rename', 'MOVED'],
  ['claim release', 'RELEASED'],
  ['tombstone deletion', '']
] as const

describe('version GC termination', () => {
  it.each(versionSteps.map(([phase], index) => ({ phase, index })))(
    'stops all cleanup after unconfirmed $phase termination',
    async ({ index }) => {
      const error = failAfter(versionSteps.slice(0, index).map(([, reply]) => reply))

      await expect(collectRelayVersions()).rejects.toBe(error)

      expect(mockExec).toHaveBeenCalledTimes(index + 1)
    }
  )

  it.each([false, true])(
    'stops after an unconfirmed stale lock probe with claim held: %s',
    async (claimed) => {
      const replies = claimed
        ? versionSteps.slice(0, 6).map(([, reply]) => String(reply))
        : [versionSteps[0][1]]
      const error = failAfter([...replies, 'LOCKED'])

      await expect(collectRelayVersions()).rejects.toBe(error)

      expect(mockExec).toHaveBeenCalledTimes(replies.length + 2)
    }
  )

  it('stops after unconfirmed abandoned tombstone deletion', async () => {
    const error = failAfter([
      'relay-0.1.0+aaa.gc-tombstone.1.1\nrelay-0.1.0+ccc.gc-tombstone.1.1\nrelay-0.1.0+ddd'
    ])

    await expect(collectRelayVersions()).rejects.toBe(error)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('preserves an unconfirmed native cache cleanup error for its caller', async () => {
    const error = failAfter([''])

    await expect(collectRelayVersions()).rejects.toBe(error)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })
})

const caches = [
  {
    name: 'native dependencies',
    collect: () => gcRelayNativeDepsCache(conn, host, home),
    listing: `ENTRY ${nativeKey}\nENTRY linux-x64-fedcba9876543210\n__ORCA_NATIVE_CACHE__LIST_OK`,
    references: '__ORCA_NATIVE_CACHE__REFS_OK'
  },
  {
    name: 'ripgrep',
    collect: () => gcRemoteRipgrepCache(conn, host, home),
    listing:
      'ENTRY 0123456789abcdef-linux-x64\nENTRY fedcba9876543210-linux-x64\n__ORCA_RG_CACHE__LIST_OK',
    references: '__ORCA_RG_CACHE__REFS_OK'
  }
]

describe.each(caches)('$name cache GC termination', ({ collect, listing, references }) => {
  const steps = [
    ['listing', listing],
    ['reference scan', references],
    ['rename', 'MOVED'],
    ['reference recheck', references],
    ['tombstone deletion', '']
  ] as const

  it.each(steps.map(([phase], index) => ({ phase, index })))(
    'preserves unconfirmed $phase termination and stops collection',
    async ({ index, phase }) => {
      const error = failAfter(steps.slice(0, index).map(([, reply]) => reply))

      await expect(collect()).rejects.toBe(error)

      expect(mockExec).toHaveBeenCalledTimes(index + (phase === 'reference recheck' ? 2 : 1))
      if (phase === 'reference recheck') {
        expect(mockExec.mock.calls.at(-1)?.[1]).toContain('if [ ! -e ')
      }
    }
  )

  it.each(steps.map(([phase], index) => ({ phase, index })))(
    'keeps a confirmed $phase failure nonfatal',
    async ({ index }) => {
      failAfter(
        steps.slice(0, index).map(([, reply]) => reply),
        true
      )

      await expect(collect()).resolves.toBeUndefined()
    }
  )

  it('stops when restoring a tombstone has unconfirmed termination', async () => {
    const error = failAfter([listing, references, 'MOVED', 'unreadable references'])

    await expect(collect()).rejects.toBe(error)

    expect(mockExec).toHaveBeenCalledTimes(5)
  })

  it.each([false, true])(
    'does not retry a failed restoration after an unconfirmed recheck: %s',
    async (confirmed) => {
      const error = failAfter([listing, references, 'MOVED'])
      mockExec.mockRejectedValueOnce(
        Object.assign(new Error('restore failed'), { sshChannelCloseConfirmed: confirmed })
      )

      await expect(collect()).rejects.toBe(error)

      expect(mockExec).toHaveBeenCalledTimes(5)
    }
  )

  it('keeps a confirmed restore failure nonfatal', async () => {
    failAfter([listing, references, 'MOVED', 'unreadable references'], true)

    await expect(collect()).resolves.toBeUndefined()
  })
})
