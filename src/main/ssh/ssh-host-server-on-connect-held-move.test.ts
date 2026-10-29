/** #27267: stopped conversions must release their fence or report it retained and resume next connect. */
import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  resolveHostServerOnConnect,
  type HostServerOnConnectDeps
} from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'
import { unservedHostServerMessage, unservedServerStatus } from './ssh-host-unserved-status'
import { admitSshManagedServerStatus } from '../../shared/ssh-managed-server-status-admission'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the orchestrator reads only the environment id.
const environment = { id: 'env-1' } as never

function fencedHost(phase: 'source-fenced' | 'destination-staged', registered: boolean) {
  const host: { phase: string | null; registered: boolean } = { phase, registered }
  return {
    host,
    deps: (overrides: Parameters<typeof hostServerDepsStub>[0] = {}) =>
      hostServerDepsStub({
        managedEnvironmentId: () => (host.phase && host.registered ? 'env-1' : null),
        hasUnfinishedConversion: () =>
          host.phase === 'source-fenced' || host.phase === 'destination-staged',
        isFencedBeforeStaging: () => host.phase === 'source-fenced',
        ...overrides
      })
  }
}

describe('a move to the managed server that stops short', () => {
  it('keeps the host locked and says the move is paused when the server cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { deps } = fencedHost('source-fenced', true)
    const d = deps({
      convert: vi.fn(async () => {
        throw new Error('Could not connect to the remote Orca runtime.')
      }),
      abandonConversion: vi.fn(async () => {
        throw new Error('Could not connect to the remote Orca runtime.')
      })
    })
    const result = await resolveHostServerOnConnect(target, d)
    expect(result).toMatchObject({ route: 'unserved', reason: 'failed', held: true })
    expect(d.abandonConversion).toHaveBeenCalledWith(target)
    // Never an unavailability record: that would stop later connects from resuming.
    expect(d.recordUnavailable).not.toHaveBeenCalled()
    if (result.route !== 'unserved') {
      throw new Error('expected unserved')
    }
    expect(unservedHostServerMessage(result)).toContain('Connect again to resume')
    expect(unservedServerStatus(result)).toMatchObject({ kind: 'relay', held: true })
    warn.mockRestore()
  })

  it('resumes the same move on the next connect once the server answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { host, deps } = fencedHost('destination-staged', true)
    const failing = deps({
      convert: vi.fn(async () => {
        throw new Error('socket closed')
      }),
      abandonConversion: vi.fn(async () => {
        throw new Error('socket closed')
      })
    })
    await expect(resolveHostServerOnConnect(target, failing)).resolves.toMatchObject({
      held: true
    })
    const convert = vi.fn(async () => {
      host.phase = 'destination-committed'
      return { outcome: 'converted' as const, environment, migrationId: 'm' }
    })
    const next = deps({ convert })
    await expect(resolveHostServerOnConnect(target, next)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    // Resumed through the registered server, without a fresh census or a second fence.
    expect(next.ensureTunnel).toHaveBeenCalledWith('env-1')
    expect(convert).toHaveBeenCalledWith(target, null)
    expect(next.relayTerminals).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('gives the host back, with no lock to report, when the server proves it holds nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { host, deps } = fencedHost('destination-staged', true)
    const d = deps({
      convert: vi.fn(async () => {
        throw new Error('orcad_migration_commit_not_committed:staged')
      }),
      abandonConversion: vi.fn(async () => {
        host.phase = null
      })
    })
    const result = await resolveHostServerOnConnect(target, d)
    expect(result).toEqual({
      route: 'unserved',
      reason: 'failed',
      detail: 'orcad_migration_commit_not_committed:staged'
    })
    if (result.route === 'unserved') {
      expect(unservedHostServerMessage(result)).toBe(
        'Orca couldn’t start its server on this host. Try connecting again.'
      )
    }
    warn.mockRestore()
  })

  it('releases a fence whose server never registered when the deploy fails or defers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stops: HostServerOnConnectDeps['convert'][] = [
      async () => {
        throw new Error('upload failed')
      },
      async () => ({
        outcome: 'deferred' as const,
        candidateVersion: '0.1.0+abc',
        code: 'orcad_update_fence_held',
        reason: 'Another desktop is updating this host.'
      })
    ]
    for (const convert of stops) {
      const { host, deps } = fencedHost('source-fenced', false)
      const d = deps({
        convert,
        abandonConversion: vi.fn(async () => {
          host.phase = null
        })
      })
      const result = await resolveHostServerOnConnect(target, d)
      expect(result).toMatchObject({ route: 'unserved' })
      expect(result).not.toHaveProperty('held')
      expect(d.abandonConversion).toHaveBeenCalledWith(target)
      expect(host.phase).toBeNull()
    }
    warn.mockRestore()
  })

  it('finishes, rather than reports a lock, when the abort finds the move already committed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { host, deps } = fencedHost('destination-staged', true)
    const lost = deps({
      convert: vi.fn(async () => {
        throw new Error('orcad_migration_commit_reply_lost')
      }),
      // The abort's re-read found the commit landed and recorded it.
      abandonConversion: vi.fn(async () => {
        host.phase = 'destination-committed'
      })
    })
    await expect(resolveHostServerOnConnect(target, lost)).resolves.not.toHaveProperty('held')
    const next = deps()
    await expect(resolveHostServerOnConnect(target, next)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    expect(next.convert).not.toHaveBeenCalled()
    expect(next.retainCommittedSource).toHaveBeenCalledWith(target)
    warn.mockRestore()
  })

  it('keeps a refusal’s own guidance even while the host stays locked', () => {
    const decision = {
      route: 'unserved' as const,
      reason: 'refused' as const,
      detail: 'remove that project from this desktop and connect again',
      held: true as const
    }
    expect(unservedHostServerMessage(decision)).toBe(decision.detail)
  })

  it('carries the lock to the renderer, and drops anything but a literal true', () => {
    expect(admitSshManagedServerStatus({ kind: 'relay', reason: 'failed', held: true })).toEqual({
      managedServer: { kind: 'relay', reason: 'failed', held: true }
    })
    expect(admitSshManagedServerStatus({ kind: 'relay', reason: 'failed', held: 'yes' })).toEqual({
      managedServer: { kind: 'relay', reason: 'failed' }
    })
  })
})
