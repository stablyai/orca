import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  OrcadHostUnsupportedError,
  OrcadStdioBridgeUnavailableError
} from './orcad-host-unavailable'
import {
  resolveHostServerOnConnect,
  type HostServerOnConnectDeps
} from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

const deps = hostServerDepsStub

describe('which server an SSH host runs on connect', () => {
  it('connects a converted host through its tunnel', async () => {
    const d = deps({ managedEnvironmentId: () => 'env-9' })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-9'
    })
    expect(d.ensureTunnel).toHaveBeenCalledWith('env-9')
    expect(d.convert).not.toHaveBeenCalled()
  })

  it('checks the server behind the tunnel on every connect to a converted host', async () => {
    const d = deps({ managedEnvironmentId: () => 'env-9' })
    await resolveHostServerOnConnect(target, d)
    expect(d.ensureServing).toHaveBeenCalledWith('env-9')
  })

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

  it('deploys an empty host directly, and converts a host with state', async () => {
    const empty = deps({ isEmptyHost: () => true })
    await expect(resolveHostServerOnConnect(target, empty)).resolves.toMatchObject({
      route: 'managed'
    })
    expect(empty.deploy).toHaveBeenCalled()
    expect(empty.relayTerminals).not.toHaveBeenCalled()

    const withState = deps()
    await expect(resolveHostServerOnConnect(target, withState)).resolves.toMatchObject({
      route: 'managed'
    })
    expect(withState.convert).toHaveBeenCalled()
    expect(withState.progress).toHaveBeenCalledWith(target, 'converting')
  })

  it('keeps the relay while relay terminals are live or unproven', async () => {
    for (const verdict of ['live', 'unverifiable'] as const) {
      const d = deps({ relayTerminals: async () => ({ verdict, count: 2 }) })
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'relay',
        reason: verdict === 'live' ? 'relay_terminals_live' : 'relay_terminals_unverifiable',
        terminals: 2
      })
      expect(d.convert).not.toHaveBeenCalled()
    }
    const elsewhere = deps({
      relayTerminals: async () => ({ verdict: 'live', count: 1, elsewhere: true })
    })
    await expect(resolveHostServerOnConnect(target, elsewhere)).resolves.toEqual({
      route: 'relay',
      reason: 'relay_terminals_live',
      terminals: 1,
      terminalsElsewhere: true
    })
    const raced = deps({
      convert: async () => ({
        outcome: 'refused',
        verdict: 'live',
        code: 'orcad_migration_terminals',
        reason: 'A relay terminal is still running.'
      })
    })
    await expect(resolveHostServerOnConnect(target, raced)).resolves.toEqual({
      route: 'relay',
      reason: 'relay_terminals_live'
    })
  })

  it('surfaces a refusal for any other reason, naming it', async () => {
    const d = deps({
      convert: async () => ({
        outcome: 'refused',
        verdict: 'live',
        code: 'orcad_migration_preflight_blocked',
        reason: 'An automation still runs on this host.'
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'relay',
      reason: 'refused',
      detail: 'An automation still runs on this host.'
    })
  })

  it('falls back to the relay ladder for good when orcad cannot run, and remembers why', async () => {
    const d = deps({
      isEmptyHost: () => true,
      deploy: async () => {
        throw new OrcadHostUnsupportedError('Packaged orcad template does not support x')
      }
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'relay',
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
    // The conversion fenced the host first; that fence must go before the relay serves it.
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
    ).resolves.toEqual({ route: 'relay', reason: 'source_changed' })
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

  it('touches no host when this build carries no orcad template', async () => {
    const d = deps({ hasTemplate: () => false, isEmptyHost: () => true })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'relay',
      reason: 'orcad_unavailable',
      detail: 'artifacts_unavailable'
    })
    expect(d.deploy).not.toHaveBeenCalled()
  })

  it('retries a transient failure on the next connect without recording it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const d = deps({
      convert: async () => {
        throw new Error('Connection lost')
      }
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'relay',
      reason: 'failed',
      detail: 'Connection lost'
    })
    expect(d.recordUnavailable).not.toHaveBeenCalled()
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
      route: 'relay',
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
      route: 'relay',
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

  it('resumes an uncommitted conversion before routing to its registered server', async () => {
    const d = deps({ managedEnvironmentId: () => 'env-9', hasUnfinishedConversion: () => true })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    // No census ran, so the conversion must prove the host's terminals itself.
    expect(d.convert).toHaveBeenCalledWith(target, null)
    expect(d.relayTerminals).not.toHaveBeenCalled()
    expect(d.retainCommittedSource).not.toHaveBeenCalled()
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
      route: 'relay',
      reason: 'failed',
      detail: 'orcad_migration_source_changed'
    })
    expect(d.abandonConversion).toHaveBeenCalledWith(target)
  })

  describe('updating a managed host on connect', () => {
    const managed = (overrides: Partial<HostServerOnConnectDeps>) =>
      deps({ managedEnvironmentId: () => 'env-9', ...overrides })

    it('connects without a note when the host already runs this build', async () => {
      const d = managed({})
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'managed',
        environmentId: 'env-9'
      })
      expect(d.autoUpdate).toHaveBeenCalledWith(
        'env-9',
        expect.objectContaining({ failedBefore: false })
      )
      expect(d.progress).not.toHaveBeenCalledWith(target, 'updating')
    })

    it('updates an older idle host, showing the update in the status line', async () => {
      const d = managed({
        autoUpdate: vi.fn(async (_id, options) => {
          options.onUpdating()
          return { outcome: 'updated' as const, activeVersion: '0.1.0+b' }
        })
      })
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'managed',
        environmentId: 'env-9'
      })
      expect(d.progress).toHaveBeenCalledWith(target, 'updating')
      expect(d.recordUpdateFailure).not.toHaveBeenCalled()
    })

    it('starts a stopped server before the update counts its terminals, as after a reboot', async () => {
      const order: string[] = []
      const d = managed({
        ensureServing: vi.fn(async () => {
          order.push('start')
          return { state: 'started' as const, boundPort: null }
        }),
        // The restarted server's fresh daemon answers zero sessions, so the update goes ahead.
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

    it('keeps the old version serving while terminals run, and retries on a later connect', async () => {
      const reason = '2 terminals are running on this host.'
      const d = managed({
        autoUpdate: async () => ({
          outcome: 'deferred',
          code: 'orcad_update_terminals_running',
          reason
        })
      })
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'managed',
        environmentId: 'env-9',
        update: { state: 'deferred', detail: reason }
      })
      expect(d.recordUpdateFailure).not.toHaveBeenCalled()
    })

    it('never downgrades a host a newer Orca activated', async () => {
      const d = managed({
        autoUpdate: async () => ({ outcome: 'skipped', reason: 'host-newer' })
      })
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'managed',
        environmentId: 'env-9',
        update: { state: 'host-newer' }
      })
    })

    it('records a rolled-back update so the same app version does not retry it', async () => {
      const reason = 'Candidate failed readiness. orcad 0.1.0+a was restarted and is serving again.'
      const failed = managed({ autoUpdate: async () => ({ outcome: 'failed', reason }) })
      await expect(resolveHostServerOnConnect(target, failed)).resolves.toMatchObject({
        route: 'managed',
        update: { state: 'failed', detail: reason }
      })
      expect(failed.recordUpdateFailure).toHaveBeenCalledWith(target, reason)

      const later = managed({
        recordedUpdateFailure: () => reason,
        autoUpdate: vi.fn(async () => ({
          outcome: 'skipped' as const,
          reason: 'failed-before' as const
        }))
      })
      await expect(resolveHostServerOnConnect(target, later)).resolves.toMatchObject({
        update: { state: 'failed', detail: reason }
      })
      expect(later.autoUpdate).toHaveBeenCalledWith(
        'env-9',
        expect.objectContaining({ failedBefore: true })
      )
      expect(later.recordUpdateFailure).not.toHaveBeenCalled()
    })

    it('clears a recorded failure once the host runs this build', async () => {
      const d = managed({ recordedUpdateFailure: () => 'earlier' })
      await resolveHostServerOnConnect(target, d)
      expect(d.clearUpdateFailure).toHaveBeenCalledWith(target)
    })

    it('still connects when the update check itself throws', async () => {
      const d = managed({
        autoUpdate: async () => {
          throw new Error('ssh dropped')
        }
      })
      await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
        route: 'managed',
        environmentId: 'env-9'
      })
      expect(d.recordUpdateFailure).not.toHaveBeenCalled()
    })
  })
})
