import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  OrcadHostUnsupportedError,
  OrcadStdioBridgeUnavailableError
} from '../../orcad/orcad-host-unavailable'
import {
  resolveHostServerOnConnect,
  type HostServerOnConnectDeps
} from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './testing/ssh-host-server-on-connect-test-deps'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

const deps = hostServerDepsStub

describe('which server an SSH host runs on connect', () => {
  it('keeps a host whose stopped server could not be started managed, with the reason', async () => {
    const detail = 'orcad did not become ready.\nLast lines of orcad.log:\nboom'
    const d = deps({
      managedEnvironmentId: () => 'env-9',
      ensureServing: vi.fn(async () => ({ state: 'unverifiable' as const, detail }))
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9',
      serving: { state: 'unverifiable', detail }
    })
    // Neither a relay fallback nor any verdict about the host's terminals.
    expect(d.relayTerminals).not.toHaveBeenCalled()
    expect(d.autoUpdate).not.toHaveBeenCalled()
  })

  it('falls back to the relay ladder for good when orcad cannot run, and remembers why', async () => {
    const d = deps({
      isEmptyHost: () => true,
      deploy: async () => {
        throw new OrcadHostUnsupportedError('Packaged orcad template does not support x')
      }
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'unserved',
      reason: 'orcad_unavailable',
      detail: 'unsupported_host'
    })
    expect(d.recordUnavailable).toHaveBeenCalledWith(target, 'unsupported_host')
    // An empty host releases its deploy claim, never a migration fence.
    expect(d.abandonDeploy).toHaveBeenCalledWith(target)
    expect(d.abandonConversion).not.toHaveBeenCalled()

    const preflight = deps({
      convert: async () => ({
        outcome: 'deferred' as const,
        candidateVersion: '1.0.0',
        code: 'orcad_candidate_preflight_failed',
        reason: 'glibc 2.17 is below the floor'
      })
    })
    await expect(resolveHostServerOnConnect(target, preflight)).resolves.toMatchObject({
      reason: 'orcad_unavailable'
    })
    expect(preflight.recordUnavailable).toHaveBeenCalledWith(target, 'native_preflight')
    // Release failed-conversion fences before direct source can serve again.
    expect(preflight.abandonConversion).toHaveBeenCalledWith(target)

    const remembered = deps({ recordedUnavailable: () => 'unsupported_host' })
    await expect(resolveHostServerOnConnect(target, remembered)).resolves.toMatchObject({
      reason: 'orcad_unavailable'
    })
    expect(remembered.convert).not.toHaveBeenCalled()
  })

  it('keeps a host an older build changed on the relay, and still connects when retaining fails', async () => {
    const changed = deps({ managedEnvironmentId: () => 'env-1' })
    await expect(
      resolveHostServerOnConnect(
        {
          ...target,
          orcadFence: { environmentId: 'env-1', sourceChangedAt: '2026-10-05T00:00:00Z' }
        },
        changed
      )
    ).resolves.toEqual({ route: 'unserved', reason: 'source_changed' })
    expect(changed.ensureTunnel).not.toHaveBeenCalled()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const managed = deps({
      managedEnvironmentId: () => 'env-1',
      retainCommittedSource: vi.fn(() => {
        throw new Error('journal unwritable')
      })
    })
    await expect(resolveHostServerOnConnect(target, managed)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    expect(managed.retainCommittedSource).toHaveBeenCalledWith(target)
    warn.mockRestore()
  })

  it('names a conflict the server will keep refusing, and the way out, instead of a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = deps({
      convert: async () => {
        throw new Error(
          'orcad_migration_stage_failed:orcad_migration_repository_path_conflict:/root/migrepo'
        )
      }
    })
    const result = await resolveHostServerOnConnect(target, d)
    expect(result).toMatchObject({ route: 'unserved', reason: 'refused' })
    const detail = result.route === 'unserved' ? result.detail : ''
    expect(detail).toContain('/root/migrepo')
    expect(detail).toContain('remove that project from this desktop and connect again')
    expect(d.abandonConversion).toHaveBeenCalledWith(target)
    warn.mockRestore()
  })

  it('never keeps a host connected for the bridge on any other refusal or a held move', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bridgedTerminals = vi.fn(async () => ({
      verdict: 'live' as const,
      count: 1,
      bridged: true as const
    }))
    const conflict = deps({
      relayTerminals: bridgedTerminals,
      convert: async () => {
        throw new Error('orcad_migration_repository_path_conflict:/root/migrepo')
      }
    })
    const refused = await resolveHostServerOnConnect(target, conflict)
    expect(refused).toMatchObject({ route: 'unserved', reason: 'refused' })
    expect(refused).not.toHaveProperty('bridged')
    const held = deps({
      relayTerminals: bridgedTerminals,
      hasUnfinishedConversion: () => true,
      convert: async () => {
        throw new Error('orcad_migration_linked_project_terminals:/root/my repo')
      }
    })
    const heldResult = await resolveHostServerOnConnect(target, held)
    expect(heldResult).toMatchObject({ route: 'unserved', reason: 'refused', held: true })
    expect(heldResult).not.toHaveProperty('bridged')
    warn.mockRestore()
  })

  it('records why when even the stdio bridge cannot reach the deployed server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = deps({
      isEmptyHost: () => true,
      deploy: vi.fn(async () => {
        throw new OrcadStdioBridgeUnavailableError('exit 127')
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'unserved',
      reason: 'orcad_unavailable',
      detail: 'ssh_tunnel_unavailable'
    })
    expect(d.abandonDeploy).toHaveBeenCalledWith(target)
    expect(d.recordUnavailable).toHaveBeenCalledWith(target, 'ssh_tunnel_unavailable')
    warn.mockRestore()
  })

  it('releases a conversion stranded before staging when no tunnel reaches its server', async () => {
    const d = deps({
      managedEnvironmentId: () => 'env-9',
      isFencedBeforeStaging: () => true,
      ensureTunnel: vi.fn(async () => {
        throw new OrcadStdioBridgeUnavailableError('exit 127')
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'unserved',
      reason: 'orcad_unavailable',
      detail: 'ssh_tunnel_unavailable'
    })
    expect(d.releaseUnreachableSetup).toHaveBeenCalledWith(target)
    expect(d.recordUnavailable).toHaveBeenCalledWith(target, 'ssh_tunnel_unavailable')
  })

  it('keeps a staged or converted host fenced when its tunnel fails', async () => {
    const failure = new OrcadStdioBridgeUnavailableError('exit 127')
    const d = deps({
      managedEnvironmentId: () => 'env-9',
      ensureTunnel: vi.fn(async () => {
        throw failure
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).rejects.toBe(failure)
    expect(d.releaseUnreachableSetup).not.toHaveBeenCalled()
  })

  it('backs an uncommitted conversion out to the relay when its commit fails', async () => {
    const d = deps({
      managedEnvironmentId: () => 'env-9',
      hasUnfinishedConversion: () => true,
      convert: vi.fn(async () => {
        throw new Error('orcad_migration_source_changed')
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toMatchObject({
      route: 'unserved',
      reason: 'failed',
      detail: 'orcad_migration_source_changed'
    })
    expect(d.abandonConversion).toHaveBeenCalledWith(target)
  })

  describe('updating a managed host on connect', () => {
    const managed = (overrides: Partial<HostServerOnConnectDeps>) =>
      deps({ managedEnvironmentId: () => 'env-9', ...overrides })

    it('starts a stopped server before the update counts its terminals, as after a reboot', async () => {
      const order: string[] = []
      const d = managed({
        ensureServing: vi.fn(async () => {
          order.push('start')
          return { state: 'started' as const, boundPort: null }
        }),
        // Wake first so the restarted daemon can supply authoritative idle census.
        autoUpdate: vi.fn(async (_id, options) => {
          order.push('update')
          options.onUpdating()
          return { outcome: 'updated' as const, activeVersion: '0.1.0+b' }
        })
      })
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'managed',
        environmentId: 'env-9'
      })
      expect(order).toEqual(['start', 'update'])
    })
  })
})
