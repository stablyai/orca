import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  OrcadHostUnsupportedError,
  OrcadStdioBridgeUnavailableError
} from './orcad-host-unavailable'
import type { ManagedOrcadAutoUpdateOutcome } from './orcad-managed-auto-update'
import type { HostServerConnectEvent } from './ssh-host-server-connect-events'
import {
  resolveHostServerOnConnect,
  type HostServerOnConnectDeps
} from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

const deps = hostServerDepsStub

async function eventsOf(d: HostServerOnConnectDeps): Promise<HostServerConnectEvent[]> {
  await resolveHostServerOnConnect(target, d).catch(() => undefined)
  return vi.mocked(d.report).mock.calls.map(([, event]) => event)
}

function decided(events: HostServerConnectEvent[]) {
  const found = events.filter((event) => event.kind === 'decided')
  expect(found).toHaveLength(1)
  return found[0]
}

describe('connect-decision telemetry', () => {
  it('reports exactly one decision per connect, naming the outcome', async () => {
    const managed = await eventsOf(deps({ managedEnvironmentId: () => 'env-9' }))
    expect(decided(managed)).toMatchObject({ outcome: 'managed', reason: 'connected' })

    const deployed = await eventsOf(deps({ isEmptyHost: () => true }))
    expect(decided(deployed)).toMatchObject({ outcome: 'deployed', reason: 'deployed' })

    const converted = await eventsOf(deps())
    expect(decided(converted)).toMatchObject({ outcome: 'converted', reason: 'converted' })
    expect(converted.filter((event) => event.kind === 'conversion')).toEqual([
      { kind: 'conversion', phase: 'started' },
      expect.objectContaining({ kind: 'conversion', phase: 'committed' })
    ])
  })

  it('names why a host stays on the relay', async () => {
    const live = await eventsOf(
      deps({ relayTerminals: async () => ({ verdict: 'live', count: 1 }) })
    )
    expect(decided(live)).toMatchObject({ outcome: 'relay', reason: 'relay_terminals_live' })

    const noTunnel = await eventsOf(
      deps({
        managedEnvironmentId: () => 'env-9',
        isFencedBeforeStaging: () => true,
        ensureTunnel: async () => {
          throw new OrcadStdioBridgeUnavailableError('no bridge')
        }
      })
    )
    expect(decided(noTunnel)).toMatchObject({ outcome: 'relay', reason: 'ssh_tunnel_unavailable' })

    const recorded = await eventsOf(deps({ recordedUnavailable: () => 'runtime_self_test' }))
    expect(decided(recorded)).toMatchObject({ reason: 'runtime_self_test', recorded: true })

    const noTemplate = await eventsOf(deps({ hasTemplate: () => false }))
    expect(decided(noTemplate)).toMatchObject({ reason: 'artifacts_unavailable' })
  })

  it('reports a refused conversion with its blocker code', async () => {
    const events = await eventsOf(
      deps({
        convert: async () => ({
          outcome: 'refused',
          verdict: 'live',
          code: 'orcad_migration_preflight_blocked',
          reason: 'An automation still runs on this host.'
        })
      })
    )
    expect(decided(events)).toMatchObject({
      reason: 'refused',
      refusal: 'orcad_migration_preflight_blocked'
    })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'conversion', phase: 'failed', failure: 'refused' })
    )
  })

  it('reports deploy failures, deferred or thrown, with their classified code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deferred = await eventsOf(
      deps({
        isEmptyHost: () => true,
        deploy: async () => ({
          outcome: 'deferred',
          candidateVersion: '1.0.0',
          code: 'orcad_activation_no_readiness',
          reason: 'No readiness line.\nLast lines of orcad.log:\nboom'
        })
      })
    )
    expect(deferred).toContainEqual(
      expect.objectContaining({
        kind: 'deploy_failed',
        context: 'deploy',
        failure: 'deferred',
        code: 'orcad_activation_no_readiness'
      })
    )
    expect(decided(deferred)).toMatchObject({ outcome: 'relay', reason: 'deferred' })

    const thrown = await eventsOf(
      deps({
        isEmptyHost: () => true,
        deploy: async () => {
          throw new OrcadHostUnsupportedError('no build for this host')
        }
      })
    )
    expect(thrown).toContainEqual(
      expect.objectContaining({ kind: 'deploy_failed', failure: 'error', code: 'unsupported_host' })
    )
    expect(decided(thrown)).toMatchObject({ reason: 'unsupported_host' })

    const conversion = await eventsOf(
      deps({
        convert: async () => ({
          outcome: 'deferred',
          candidateVersion: '1.0.0',
          code: 'orcad_update_terminals_running',
          reason: 'Terminals are running.'
        })
      })
    )
    expect(conversion).toContainEqual(
      expect.objectContaining({ kind: 'conversion', phase: 'failed', failure: 'deferred' })
    )
    expect(conversion).toContainEqual(
      expect.objectContaining({ kind: 'deploy_failed', context: 'conversion' })
    )
    warn.mockRestore()
  })

  it('shows a deferral reason, log tail included, under the SSH host', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reason = 'No readiness line.\nLast lines of orcad.log:\nError: EADDRINUSE'
    const d = deps({
      isEmptyHost: () => true,
      deploy: async () => ({
        outcome: 'deferred',
        candidateVersion: '1.0.0',
        code: 'orcad_activation_no_readiness',
        reason
      })
    })
    await expect(resolveHostServerOnConnect(target, d)).resolves.toEqual({
      route: 'relay',
      reason: 'deferred',
      detail: reason
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferred'), reason)
    warn.mockRestore()
  })

  it('still reports, as failed, a decision that throws, and a throwing reporter never fails a connect', async () => {
    const d = deps({
      managedEnvironmentId: () => 'env-9',
      ensureTunnel: async () => {
        throw new Error('tunnel failed')
      }
    })
    expect(decided(await eventsOf(d))).toMatchObject({ outcome: 'relay', reason: 'failed' })

    const throwing = deps({
      report: () => {
        throw new Error('telemetry broke')
      }
    })
    await expect(resolveHostServerOnConnect(target, throwing)).resolves.toMatchObject({
      route: 'managed'
    })
  })

  it('names what a managed host update on connect did', async () => {
    const managed = (overrides: Partial<HostServerOnConnectDeps>) =>
      eventsOf(deps({ managedEnvironmentId: () => 'env-9', ...overrides }))
    const outcomes: [ManagedOrcadAutoUpdateOutcome, string][] = [
      [{ outcome: 'skipped', reason: 'current' }, 'connected'],
      [{ outcome: 'updated', activeVersion: '0.1.0+b' }, 'updated'],
      [
        { outcome: 'deferred', code: 'orcad_update_terminals_running', reason: 'r' },
        'update_deferred'
      ],
      [{ outcome: 'failed', reason: 'r' }, 'update_failed'],
      [{ outcome: 'skipped', reason: 'host-newer' }, 'update_host_newer'],
      [{ outcome: 'skipped', reason: 'rolled-back' }, 'update_rolled_back']
    ]
    for (const [outcome, reason] of outcomes) {
      expect(decided(await managed({ autoUpdate: async () => outcome }))).toMatchObject({
        outcome: 'managed',
        reason,
        recorded: false
      })
    }
    const thrown = await managed({
      autoUpdate: async () => {
        throw new Error('ssh dropped')
      }
    })
    expect(decided(thrown)).toMatchObject({ outcome: 'managed', reason: 'update_check_failed' })
    const held = await managed({
      recordedUpdateFailure: () => 'earlier',
      autoUpdate: async () => ({ outcome: 'skipped', reason: 'failed-before' })
    })
    expect(decided(held)).toMatchObject({ reason: 'update_failed', recorded: true })
  })
})
