import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { OrcadHostUnsupportedError } from './orcad-host-unavailable'
import {
  resolveHostServerOnConnect,
  type HostServerOnConnectDeps
} from './ssh-host-server-on-connect'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the orchestrator reads only the environment id.
const environment = { id: 'env-1' } as never

function deps(overrides: Partial<HostServerOnConnectDeps> = {}): HostServerOnConnectDeps {
  return {
    managedEnvironmentId: () => null,
    ensureTunnel: vi.fn(async () => undefined),
    retireRetainedSource: vi.fn(async () => undefined),
    abandonConversion: vi.fn(async () => undefined),
    abandonDeploy: vi.fn(async () => undefined),
    hasTemplate: () => true,
    recordedUnavailable: () => null,
    recordUnavailable: vi.fn(),
    isEmptyHost: () => false,
    relayTerminals: vi.fn(async () => ({ verdict: 'exited' as const, count: 0 })),
    deploy: vi.fn(async () => ({ outcome: 'created' as const, environment, activeVersion: '1' })),
    convert: vi.fn(async () => ({ outcome: 'converted' as const, environment, migrationId: 'm' })),
    progress: vi.fn(),
    ...overrides
  }
}

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

  it('keeps a host an older build changed on the relay, and retires a retained source when on', async () => {
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
      retireRetainedSource: vi.fn(async () => {
        throw new Error('flush failed')
      })
    })
    await expect(resolveHostServerOnConnect(target, managed)).resolves.toEqual({
      route: 'managed',
      environmentId: 'env-1'
    })
    expect(managed.retireRetainedSource).toHaveBeenCalledWith(target)
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
      reason: 'failed'
    })
    expect(d.recordUnavailable).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
