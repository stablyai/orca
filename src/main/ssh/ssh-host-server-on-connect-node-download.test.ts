/** Carry structured Node-download failure for the mirror offer; never infer it from message text. */
import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'
import { unservedHostServerMessage, unservedServerStatus } from './ssh-host-unserved-status'
import { sftpSessionClosedError } from './ssh-file-transfer-abort'
import { NodeRuntimeUnreachableError } from '../managed-server/install/remote-node-runtime-host-download'
import { admitSshManagedServerStatus } from '../../shared/ssh-managed-server-status-admission'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

function unreachable(mirror?: 'unset' | 'tried' | 'unsupported'): NodeRuntimeUnreachableError {
  return new NodeRuntimeUnreachableError(
    'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz',
    'its downloads failed (curl: (7) Failed to connect)',
    '/cache/node/archives/node.tar.gz',
    new Error('net::ERR_CONNECTION_REFUSED'),
    mirror
  )
}

async function deployFailingWith(error: unknown) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const result = await resolveHostServerOnConnect(
      target,
      hostServerDepsStub({
        isEmptyHost: () => true,
        deploy: async () => {
          throw error
        }
      })
    )
    if (result.route !== 'unserved') {
      throw new Error('expected unserved')
    }
    return result
  } finally {
    warn.mockRestore()
  }
}

describe('a managed-server setup that could not download Node', () => {
  it.each(['unset', 'tried', 'unsupported'] as const)(
    'publishes the blocked download with mirror %s',
    async (mirror) => {
      const result = await deployFailingWith(unreachable(mirror))
      expect(result).toMatchObject({
        reason: 'failed',
        nodeDownloadBlocked: { mirror }
      })
      expect(result.detail).toContain('Neither this computer nor the host could download Node')
      expect(admitSshManagedServerStatus(unservedServerStatus(result))).toEqual({
        managedServer: expect.objectContaining({
          kind: 'relay',
          reason: 'failed',
          nodeDownloadBlocked: { mirror }
        })
      })
      const message = unservedHostServerMessage(result)
      expect(message).toContain('Neither this computer nor this host could download Node.js')
      if (mirror === 'unsupported') {
        expect(message).not.toContain('mirror')
      } else {
        expect(message).toContain(mirror === 'tried' ? 'Check the mirror' : 'Set a Node.js')
      }
    }
  )

  it('reads the flag through a wrapping install error', async () => {
    const wrapped = new Error('Installing the runtime failed', { cause: unreachable('unset') })
    await expect(deployFailingWith(wrapped)).resolves.toMatchObject({
      nodeDownloadBlocked: { mirror: 'unset' }
    })
  })

  it('never reads the flag from message text', async () => {
    const lookalike = new Error(unreachable('unset').message)
    const result = await deployFailingWith(lookalike)
    expect(result).not.toHaveProperty('nodeDownloadBlocked')
    expect(unservedHostServerMessage(result)).toContain('Try connecting again')
  })

  it('lets lost contact win, since nothing proves the host failed', async () => {
    const lost = new Error('upload failed', { cause: sftpSessionClosedError() })
    const result = await deployFailingWith(lost)
    expect(result).toMatchObject({ contactLost: true })
    expect(result).not.toHaveProperty('nodeDownloadBlocked')
  })

  it('drops an unknown mirror state from a newer build at admission', () => {
    expect(
      admitSshManagedServerStatus({
        kind: 'relay',
        reason: 'failed',
        nodeDownloadBlocked: { mirror: 'regional' }
      })
    ).toEqual({ managedServer: { kind: 'relay', reason: 'failed' } })
  })
})
