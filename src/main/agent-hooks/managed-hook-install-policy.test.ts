import { afterEach, describe, expect, it } from 'vitest'
import {
  getManagedHookInstallDecision,
  resolveManagedHookInstallDecision,
  setManagedHookInstallDecisionResolver,
  type ManagedHookInstallationMarker,
  type ManagedHookInstallHostMode
} from './managed-hook-install-policy'

const PRE_CHANGE: ManagedHookInstallationMarker = {
  installCohort: 'pre-change',
  onboardingDecision: 'passed'
}
const FRESH_PENDING: ManagedHookInstallationMarker = {
  installCohort: 'post-change',
  onboardingDecision: 'pending'
}
const FRESH_PASSED: ManagedHookInstallationMarker = {
  installCohort: 'post-change',
  onboardingDecision: 'passed'
}
// What a torn or hand-edited record normalizes to. The parser answers `null`, and `null` means the
// installation is unrecorded, which is the pre-change cohort — never pending.
const UNRECORDED = undefined

afterEach(() => setManagedHookInstallDecisionResolver(null))

describe('getManagedHookInstallDecision', () => {
  const cases: {
    name: string
    enabled?: boolean
    installation: ManagedHookInstallationMarker | undefined
    mode: ManagedHookInstallHostMode
    expected: ReturnType<typeof getManagedHookInstallDecision>
  }[] = [
    {
      name: 'an existing user upgrading installs, onboarding state notwithstanding',
      installation: PRE_CHANGE,
      mode: 'desktop',
      expected: { kind: 'allow', reason: 'pre-change' }
    },
    {
      name: 'an unrecorded installation installs',
      installation: UNRECORDED,
      mode: 'desktop',
      expected: { kind: 'allow', reason: 'pre-change' }
    },
    {
      name: 'a fresh desktop install defers until the question is answered',
      installation: FRESH_PENDING,
      mode: 'desktop',
      expected: { kind: 'defer', reason: 'onboarding-pending' }
    },
    {
      name: 'a fresh install that answered installs',
      installation: FRESH_PASSED,
      mode: 'desktop',
      expected: { kind: 'allow', reason: 'onboarding-passed' }
    },
    {
      name: 'a serve host never defers — it never paints the wizard',
      installation: FRESH_PENDING,
      mode: 'serve',
      expected: { kind: 'allow', reason: 'headless' }
    },
    {
      name: 'orcad never defers',
      installation: FRESH_PENDING,
      mode: 'orcad',
      expected: { kind: 'allow', reason: 'headless' }
    },
    {
      name: 'the CLI never defers',
      installation: FRESH_PENDING,
      mode: 'cli',
      expected: { kind: 'allow', reason: 'headless' }
    },
    {
      name: 'the off switch outranks the pre-change cohort',
      enabled: false,
      installation: PRE_CHANGE,
      mode: 'desktop',
      expected: { kind: 'deny', reason: 'hooks-disabled' }
    },
    {
      name: 'the off switch outranks a headless host',
      enabled: false,
      installation: FRESH_PENDING,
      mode: 'serve',
      expected: { kind: 'deny', reason: 'hooks-disabled' }
    },
    {
      name: 'the off switch outranks a passed onboarding',
      enabled: false,
      installation: FRESH_PASSED,
      mode: 'desktop',
      expected: { kind: 'deny', reason: 'hooks-disabled' }
    }
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        getManagedHookInstallDecision({
          settings:
            testCase.enabled === undefined ? {} : { agentStatusHooksEnabled: testCase.enabled },
          installation: testCase.installation,
          mode: testCase.mode
        })
      ).toEqual(testCase.expected)
    })
  }

  it('treats an absent settings object as on, because the default is on', () => {
    expect(
      getManagedHookInstallDecision({ settings: null, installation: PRE_CHANGE, mode: 'desktop' })
    ).toEqual({ kind: 'allow', reason: 'pre-change' })
  })
})

describe('resolveManagedHookInstallDecision without a host resolver', () => {
  it('installs, because an unestablished installation is an ambiguous one', () => {
    expect(resolveManagedHookInstallDecision({})).toEqual({ kind: 'allow', reason: 'pre-change' })
  })

  it('still denies an explicit off switch, so no caller can install against it', () => {
    expect(resolveManagedHookInstallDecision({ agentStatusHooksEnabled: false })).toEqual({
      kind: 'deny',
      reason: 'hooks-disabled'
    })
  })

  it('uses the host resolver once one is installed', () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))

    expect(resolveManagedHookInstallDecision({})).toEqual({
      kind: 'defer',
      reason: 'onboarding-pending'
    })
  })
})
