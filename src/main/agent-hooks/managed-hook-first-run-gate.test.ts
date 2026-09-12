import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  isManagedHookFirstRunGatePending,
  isManagedHookInstallDeferredForFirstRun
} from './managed-hook-first-run-gate'

type Latch = GlobalSettings['managedAgentHookFirstRunGate']

const cases: {
  name: string
  latch: Latch
  closedAt: number | null
  lastCompletedStep: number
  deferred: boolean
}[] = [
  {
    name: 'fresh profile that has not passed step 1',
    latch: 'pending',
    closedAt: null,
    lastCompletedStep: -1,
    deferred: true
  },
  {
    name: 'fresh profile still sitting on step 0',
    latch: 'pending',
    closedAt: null,
    lastCompletedStep: 0,
    deferred: true
  },
  {
    name: 'fresh profile that just passed step 1',
    latch: 'pending',
    closedAt: null,
    lastCompletedStep: 1,
    deferred: false
  },
  {
    name: 'fresh profile whose wizard was dismissed',
    latch: 'pending',
    closedAt: 1,
    lastCompletedStep: -1,
    deferred: false
  },
  {
    name: 'retired latch, wizard re-opened to the start',
    latch: 'done',
    closedAt: null,
    lastCompletedStep: -1,
    deferred: false
  },
  {
    name: 'pre-release profile with no latch at all',
    latch: undefined,
    closedAt: null,
    lastCompletedStep: -1,
    deferred: false
  }
]

describe('isManagedHookInstallDeferredForFirstRun', () => {
  for (const testCase of cases) {
    it(`${testCase.deferred ? 'defers' : 'does not defer'} for a ${testCase.name}`, () => {
      expect(
        isManagedHookInstallDeferredForFirstRun({
          onboarding: {
            closedAt: testCase.closedAt,
            lastCompletedStep: testCase.lastCompletedStep
          },
          settings: { managedAgentHookFirstRunGate: testCase.latch }
        })
      ).toBe(testCase.deferred)
    })
  }

  it('fails open when settings are unavailable', () => {
    const onboarding = { closedAt: null, lastCompletedStep: -1 }
    expect(isManagedHookInstallDeferredForFirstRun({ onboarding, settings: null })).toBe(false)
    expect(isManagedHookInstallDeferredForFirstRun({ onboarding, settings: undefined })).toBe(false)
  })
})

describe('isManagedHookFirstRunGatePending', () => {
  it('is true only while the latch is armed', () => {
    expect(isManagedHookFirstRunGatePending({ managedAgentHookFirstRunGate: 'pending' })).toBe(true)
    expect(isManagedHookFirstRunGatePending({ managedAgentHookFirstRunGate: 'done' })).toBe(false)
    expect(isManagedHookFirstRunGatePending({})).toBe(false)
    expect(isManagedHookFirstRunGatePending(null)).toBe(false)
  })
})
