import { describe, expect, it } from 'vitest'
import { resolveExternalAutomationScope } from './external-automation-owner-guard'
import { AutomationOwnerConflictError } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automation-owner-ref'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError
} from '../../shared/external-automation-scope'
import type { ExternalAutomationProvider } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'

function sshTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-a',
    label: 'Build box',
    host: 'build.example',
    port: 22,
    username: 'orca',
    generation: 3,
    ...overrides
  }
}

function registry(targets: SshTarget[]): { getSshTargets: () => SshTarget[] } {
  return { getSshTargets: () => targets }
}

const desktopSelf: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}

function desktopSsh(targetId: string, targetGeneration: number): AutomationOwnerRef {
  return { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId, targetGeneration } }
}

describe('resolveExternalAutomationScope', () => {
  it('resolves desktop + self to the local target', () => {
    const scope = resolveExternalAutomationScope(
      { owner: desktopSelf, provider: 'hermes' },
      registry([])
    )

    expect(scope.target).toEqual({ type: 'local' })
    expect(scope.sshTarget).toBeNull()
    expect(scope.managerId).toBe('hermes:local')
  })

  it('resolves a desktop SSH host whose registration generation still matches', () => {
    const target = sshTarget()

    const scope = resolveExternalAutomationScope(
      { owner: desktopSsh('target-a', 3), provider: 'openclaw' },
      registry([target])
    )

    expect(scope.target).toEqual({ type: 'ssh', connectionId: 'target-a' })
    expect(scope.sshTarget).toBe(target)
    expect(scope.managerId).toBe('openclaw:ssh:target-a')
  })

  it('excludes a runtime-owned target instead of exposing it', () => {
    const target = sshTarget({ owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' } })

    expect(() =>
      resolveExternalAutomationScope(
        { owner: desktopSsh('target-a', 3), provider: 'hermes' },
        registry([target])
      )
    ).toThrow(ExternalAutomationScopeError)
    try {
      resolveExternalAutomationScope(
        { owner: desktopSsh('target-a', 3), provider: 'hermes' },
        registry([target])
      )
    } catch (error) {
      expect((error as ExternalAutomationScopeError).code).toBe(
        EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden
      )
    }
  })

  it('hides a runtime-owned target even when the captured generation is wrong', () => {
    const target = sshTarget({
      generation: 9,
      owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' }
    })

    try {
      resolveExternalAutomationScope(
        { owner: desktopSsh('target-a', 3), provider: 'hermes' },
        registry([target])
      )
      expect.unreachable('hidden target must not resolve')
    } catch (error) {
      expect((error as ExternalAutomationScopeError).code).toBe(
        EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden
      )
    }
  })

  it('fails closed with the host-changed conflict on a stale generation', () => {
    try {
      resolveExternalAutomationScope(
        { owner: desktopSsh('target-a', 2), provider: 'hermes' },
        registry([sshTarget({ generation: 3 })])
      )
      expect.unreachable('stale generation must not resolve')
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationOwnerConflictError)
      expect((error as AutomationOwnerConflictError).code).toBe('automation_owner_changed')
    }
  })

  it('fails closed when the registration carries no usable generation', () => {
    try {
      resolveExternalAutomationScope(
        { owner: desktopSsh('target-a', 1), provider: 'hermes' },
        registry([sshTarget({ generation: undefined })])
      )
      expect.unreachable('unstamped registration must not resolve')
    } catch (error) {
      expect((error as AutomationOwnerConflictError).code).toBe('automation_owner_changed')
    }
  })

  it('reports a removed SSH host as a target-removed conflict', () => {
    try {
      resolveExternalAutomationScope(
        { owner: desktopSsh('gone', 1), provider: 'hermes' },
        registry([sshTarget()])
      )
      expect.unreachable('missing target must not resolve')
    } catch (error) {
      expect((error as AutomationOwnerConflictError).code).toBe('automation_target_removed')
    }
  })

  it('rejects a runtime authority rather than tunnelling it to the desktop surface', () => {
    const runtimeOwner: AutomationOwnerRef = {
      authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 4 },
      selector: { kind: 'self' }
    }

    try {
      resolveExternalAutomationScope({ owner: runtimeOwner, provider: 'hermes' }, registry([]))
      expect.unreachable('runtime authority must not resolve')
    } catch (error) {
      expect((error as ExternalAutomationScopeError).code).toBe(
        EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported
      )
    }
  })

  it('rejects a provider outside the allowlist', () => {
    try {
      resolveExternalAutomationScope(
        { owner: desktopSelf, provider: 'cron' as ExternalAutomationProvider },
        registry([])
      )
      expect.unreachable('unknown provider must not resolve')
    } catch (error) {
      expect((error as ExternalAutomationScopeError).code).toBe(
        EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed
      )
    }
  })
})
