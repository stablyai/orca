import { afterEach, describe, expect, it } from 'vitest'
import {
  setManagedHookInstallDecisionResolver,
  type ManagedHookInstallDecision
} from '../agent-hooks/managed-hook-install-policy'
import { resolveStartupManagedHookPlan } from './startup-managed-hook-plan'

const ALLOW: ManagedHookInstallDecision = { kind: 'allow', reason: 'pre-change' }
const DEFER: ManagedHookInstallDecision = { kind: 'defer', reason: 'onboarding-pending' }
const DENY: ManagedHookInstallDecision = { kind: 'deny', reason: 'hooks-disabled' }

afterEach(() => setManagedHookInstallDecisionResolver(null))

describe('resolveStartupManagedHookPlan', () => {
  it('reconciles when the host allows and this build installs hooks', () => {
    setManagedHookInstallDecisionResolver(() => ALLOW)

    expect(resolveStartupManagedHookPlan({ managedHooksInstallable: true, settings: {} })).toEqual({
      decision: ALLOW,
      shouldReconcile: true
    })
  })

  it('does not reconcile while the first-run question is unanswered', () => {
    setManagedHookInstallDecisionResolver(() => DEFER)

    expect(resolveStartupManagedHookPlan({ managedHooksInstallable: true, settings: {} })).toEqual({
      decision: DEFER,
      shouldReconcile: false
    })
  })

  it('does not reconcile when hooks are turned off', () => {
    setManagedHookInstallDecisionResolver(() => DENY)

    expect(resolveStartupManagedHookPlan({ managedHooksInstallable: true, settings: {} })).toEqual({
      decision: DENY,
      shouldReconcile: false
    })
  })

  it('carries the decision even when this build never reconciles', () => {
    setManagedHookInstallDecisionResolver(() => ALLOW)

    expect(resolveStartupManagedHookPlan({ managedHooksInstallable: false, settings: {} })).toEqual(
      { decision: ALLOW, shouldReconcile: false }
    )
  })

  it('installs with no host resolver, because an unestablished installation is ambiguous', () => {
    expect(resolveStartupManagedHookPlan({ managedHooksInstallable: true, settings: {} })).toEqual({
      decision: ALLOW,
      shouldReconcile: true
    })
  })
})
