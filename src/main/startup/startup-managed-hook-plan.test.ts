import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveStartupManagedHookPlan } from './startup-managed-hook-plan'

type Latch = GlobalSettings['managedAgentHookFirstRunGate']

function plan(overrides: {
  managedHooksInstallable?: boolean
  isServeMode?: boolean
  closedAt?: number | null
  lastCompletedStep?: number
  latch?: Latch
  agentStatusHooksEnabled?: boolean
}) {
  return resolveStartupManagedHookPlan({
    managedHooksInstallable: overrides.managedHooksInstallable ?? true,
    isServeMode: overrides.isServeMode ?? false,
    onboarding: {
      closedAt: overrides.closedAt ?? null,
      lastCompletedStep: overrides.lastCompletedStep ?? -1
    },
    settings: {
      managedAgentHookFirstRunGate: overrides.latch,
      agentStatusHooksEnabled: overrides.agentStatusHooksEnabled ?? true
    }
  })
}

const cases: {
  name: string
  input: Parameters<typeof plan>[0]
  expected: ReturnType<typeof resolveStartupManagedHookPlan>
}[] = [
  {
    name: 'fresh profile before step 1 defers and keeps the latch armed',
    input: { latch: 'pending' },
    expected: { deferForFirstRun: true, shouldRetireFirstRunLatch: false, shouldReconcile: false }
  },
  {
    name: 'fresh profile still on step 0 defers',
    input: { latch: 'pending', lastCompletedStep: 0 },
    expected: { deferForFirstRun: true, shouldRetireFirstRunLatch: false, shouldReconcile: false }
  },
  {
    name: 'a relaunch after step 1 reconciles and retires the latch',
    input: { latch: 'pending', lastCompletedStep: 1 },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: true, shouldReconcile: true }
  },
  {
    name: 'a relaunch after the wizard was dismissed reconciles and retires the latch',
    input: { latch: 'pending', closedAt: 1 },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: true, shouldReconcile: true }
  },
  {
    name: 'a serve host never defers, because it never paints the wizard',
    input: { latch: 'pending', isServeMode: true },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: true, shouldReconcile: true }
  },
  {
    name: 'a retired latch reconciles even with the wizard rewound to the start',
    input: { latch: 'done' },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: false, shouldReconcile: true }
  },
  {
    name: 'a pre-release profile with no latch is untouched',
    input: { latch: undefined },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: false, shouldReconcile: true }
  },
  {
    name: 'the off switch still wins once the gate has lifted',
    input: { latch: 'done', agentStatusHooksEnabled: false },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: false, shouldReconcile: false }
  },
  {
    name: 'a build that does not install managed hooks reconciles nothing',
    input: { latch: 'done', managedHooksInstallable: false },
    expected: { deferForFirstRun: false, shouldRetireFirstRunLatch: false, shouldReconcile: false }
  },
  {
    name: 'a deferring launch retires nothing even when the build cannot install',
    input: { latch: 'pending', managedHooksInstallable: false },
    expected: { deferForFirstRun: true, shouldRetireFirstRunLatch: false, shouldReconcile: false }
  }
]

describe('resolveStartupManagedHookPlan', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(plan(testCase.input)).toEqual(testCase.expected)
    })
  }
})
