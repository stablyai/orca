/** Lost contact during install is unverifiable host outcome, never proof the server failed to start. */
import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'
import { unservedHostServerMessage, unservedServerStatus } from './ssh-host-unserved-status'
import { sftpSessionClosedError } from './ssh-file-transfer-abort'
import { sshChannelOpenTimeoutError } from './ssh-channel-open'
import { admitSshManagedServerStatus } from '../../shared/ssh-managed-server-status-admission'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

async function deployFailingWith(error: Error) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    return await resolveHostServerOnConnect(
      target,
      hostServerDepsStub({
        isEmptyHost: () => true,
        deploy: async () => {
          throw error
        }
      })
    )
  } finally {
    warn.mockRestore()
  }
}

describe('a managed-server install that loses contact with the host', () => {
  it('says contact was lost when the upload’s SSH session closes', async () => {
    const result = await deployFailingWith(sftpSessionClosedError())
    expect(result).toMatchObject({ route: 'unserved', reason: 'failed', contactLost: true })
    if (result.route !== 'unserved') {
      throw new Error('expected unserved')
    }
    expect(unservedHostServerMessage(result)).toMatch(
      /lost contact.*Nothing on the host was stopped/
    )
    expect(admitSshManagedServerStatus(unservedServerStatus(result))).toMatchObject({
      managedServer: { kind: 'relay', reason: 'failed', contactLost: true }
    })
  })

  it('says contact was lost when the host never answers a channel open', async () => {
    const unanswered = sshChannelOpenTimeoutError('SSH SFTP channel timed out')
    await expect(deployFailingWith(unanswered)).resolves.toMatchObject({ contactLost: true })
  })

  it('reads lost contact through a wrapping install error', async () => {
    const wrapped = new Error('Uploading the runtime failed', { cause: sftpSessionClosedError() })
    await expect(deployFailingWith(wrapped)).resolves.toMatchObject({ contactLost: true })
  })

  it('does not call a host’s own unconfirmed answer lost contact', async () => {
    const busy = Object.assign(new Error('STATE_MUTATION_DEADLINE'), {
      sshChannelCloseConfirmed: false
    })
    await expect(deployFailingWith(busy)).resolves.not.toHaveProperty('contactLost')
  })

  it('keeps the plain try-again for a failure the host answered', async () => {
    const result = await deployFailingWith(new Error('tar: Unexpected EOF in archive'))
    expect(result).not.toHaveProperty('contactLost')
    if (result.route !== 'unserved') {
      throw new Error('expected unserved')
    }
    expect(unservedHostServerMessage(result)).toContain('Try connecting again')
  })
})
