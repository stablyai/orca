import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

import { gcOldRemoteInstallVersions } from './remote-install-gc'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedSshConnection } from '../../ssh/unused-host-transport.test-fixture'

const conn = unusedSshConnection()
const host = getRemoteHostPlatform('linux-x64')
const home = '/home/u'
const currentDir = `${home}/.orca-remote/orcad-0.1.0+bbb`
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

function collectVersions(): Promise<void> {
  return gcOldRemoteInstallVersions(conn, ORCAD_INSTALL_MODEL, home, currentDir, host, {
    isDirLive: async (dir) => (await execCommand(conn, `liveness ${dir}`)).trim() !== 'DEAD'
  })
}

const versionSteps = [
  ['listing', 'orcad-0.1.0+aaa'],
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

      await expect(collectVersions()).rejects.toBe(error)

      expect(mockExec).toHaveBeenCalledTimes(index + 1)
    }
  )

  it.each([false, true])(
    'stops after an unconfirmed stale lock probe with claim held: %s',
    async (claimed) => {
      const replies = claimed
        ? versionSteps.slice(0, 6).map(([, reply]) => String(reply))
        : versionSteps.slice(0, 1).map(([, reply]) => String(reply))
      const error = failAfter([...replies, 'LOCKED'])

      await expect(collectVersions()).rejects.toBe(error)

      expect(mockExec).toHaveBeenCalledTimes(replies.length + 2)
    }
  )

  it('stops after unconfirmed abandoned tombstone deletion', async () => {
    const error = failAfter([
      'orcad-0.1.0+aaa.gc-tombstone.1.1\norcad-0.1.0+ccc.gc-tombstone.1.1\norcad-0.1.0+ddd'
    ])

    await expect(collectVersions()).rejects.toBe(error)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })
})
