import { describe, expect, it } from 'vitest'
import { resolveExternalAutomationScope } from './external-automation-owner-guard'
import { AutomationOwnerConflictError } from '../../shared/automations/ownership/automation-owner-conflict'
import type { AutomationOwnerRef } from '../../shared/automations/ownership/automation-owner-ref'

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

function desktopSsh(targetId: string, targetGeneration: number): AutomationOwnerRef {
  return { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId, targetGeneration } }
}

describe('resolveExternalAutomationScope', () => {
  it('fails closed with the host-changed conflict on a stale generation', () => {
    try {
      resolveExternalAutomationScope(
        { owner: desktopSsh('target-a', 2), provider: 'openclaw' },
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
        { owner: desktopSsh('target-a', 1), provider: 'openclaw' },
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
        { owner: desktopSsh('gone', 1), provider: 'openclaw' },
        registry([sshTarget()])
      )
      expect.unreachable('missing target must not resolve')
    } catch (error) {
      expect((error as AutomationOwnerConflictError).code).toBe('automation_target_removed')
    }
  })
})
