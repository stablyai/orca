/** A setup whose SSH dial never reached the host fails with SSH's reason, never as a server failure. */
import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveHostServerOnConnect } from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'
import { markSshSessionStartFailure } from './ssh-session-start-failure'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  return run().finally(() => warn.mockRestore())
}

describe('a connect whose SSH session never opens', () => {
  it('fails a fresh host with the SSH error and releases its deploy claim', async () => {
    const rejected = markSshSessionStartFailure(
      new Error('All configured authentication methods failed')
    )
    const deps = hostServerDepsStub({
      isEmptyHost: () => true,
      deploy: async () => {
        throw new Error('Deploy failed', { cause: rejected })
      }
    })
    await expect(quietly(() => resolveHostServerOnConnect(target, deps))).rejects.toThrow(
      'Deploy failed'
    )
    expect(deps.abandonDeploy).toHaveBeenCalledWith(target)
    expect(deps.recordUnavailable).not.toHaveBeenCalled()
  })

  it('fails a host with saved projects the same way when its move cannot dial', async () => {
    const refused = markSshSessionStartFailure(new Error('connect ECONNREFUSED 10.0.0.1:22'))
    const deps = hostServerDepsStub({
      convert: async () => {
        throw refused
      }
    })
    await expect(quietly(() => resolveHostServerOnConnect(target, deps))).rejects.toBe(refused)
    expect(deps.abandonConversion).toHaveBeenCalledWith(target)
  })

  it('keeps a held move’s status, which offers the way to finish it', async () => {
    const timedOut = markSshSessionStartFailure(
      new Error('Timed out while waiting for SSH authentication')
    )
    const deps = hostServerDepsStub({
      hasUnfinishedConversion: () => true,
      convert: async () => {
        throw timedOut
      }
    })
    await expect(quietly(() => resolveHostServerOnConnect(target, deps))).resolves.toMatchObject({
      route: 'unserved',
      reason: 'failed',
      held: true
    })
  })
})
