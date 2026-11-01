import { describe, expect, it } from 'vitest'
import type { SourceControlNextStep } from '../../../src/shared/source-control-next-step-decision'
import {
  buildMobileNextStepBar,
  type BuildMobileNextStepBarArgs
} from './mobile-source-control-next-step'

const noop = () => {}

function bar(step: SourceControlNextStep) {
  const args: BuildMobileNextStepBarArgs = {
    step,
    primaryAction: {
      kind: 'commit',
      label: 'Commit',
      accessibilityLabel: 'Commit',
      accessibilityHint: '',
      disabled: false,
      loading: false,
      onPress: noop
    },
    createPrAction: {
      visible: false,
      label: 'Create pull request',
      reviewLabel: 'pull request',
      disabled: false,
      loading: false,
      pushFirst: false,
      onPress: noop
    },
    pr: null,
    prDetails: null,
    createBlocked: false,
    agentName: 'Claude',
    busy: {
      completingMerge: false,
      agentLaunch: false,
      agentUnavailable: false,
      merge: false,
      autoMerge: false,
      ioBusy: false,
      prMutationsBlocked: false
    },
    handlers: {
      completeMerge: noop,
      resolveConflicts: noop,
      fixChecks: noop,
      merge: noop,
      setAutoMerge: noop
    }
  }
  return buildMobileNextStepBar(args)
}

describe('the next-step bar reason line', () => {
  // The PR tab's gate row already says "Conflicts with main"; the button names the fix, so a reason would repeat it.
  it.each(['local', 'review'] as const)('leaves Resolve with the agent bare (%s)', (scope) => {
    const view = bar({ kind: 'resolve_conflicts', scope })
    expect(view).toMatchObject({ kind: 'button', label: 'Resolve with Claude', reason: null })
  })

  it('keeps the reason beside Fix, whose label does not say what failed', () => {
    const view = bar({ kind: 'fix_checks', failedChecks: 2 })
    expect(view).toMatchObject({ kind: 'button', label: 'Fix with Claude' })
    expect(view.kind === 'button' ? view.reason?.text : null).toBe('2 checks failing')
  })
})
