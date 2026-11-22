import { describe, expect, it } from 'vitest'
import { droidSpecApproval } from './droid-spec-approval'

// Droid 1.17.2 ExitSpecMode, as recorded over ACP.
const specRequest = {
  sessionId: 'session-1',
  options: [
    { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
    {
      optionId: 'proceed_auto_run_low',
      name: 'Allow & auto-run (low risk)',
      kind: 'allow_always'
    },
    {
      optionId: 'proceed_auto_run_medium',
      name: 'Allow & auto-run (medium risk)',
      kind: 'allow_always'
    },
    {
      optionId: 'proceed_auto_run_high',
      name: 'Allow & auto-run (high risk)',
      kind: 'allow_always'
    },
    { optionId: 'cancel', name: 'No, keep iterating on spec', kind: 'reject_once' }
  ],
  toolCall: {
    toolCallId: 'call_1',
    title: 'Approve Spec',
    kind: 'switch_mode',
    name: 'ExitSpecMode',
    rawInput: { title: 'Create hello.txt', plan: '1. Create `hello.txt` containing `hi`.' }
  }
}

function answer(optionId: string, buildMode: string) {
  const presentation = droidSpecApproval('session/request_permission', specRequest)!
  return presentation.reply({ kind: 'option', optionId }, { buildMode })
}

describe('droidSpecApproval', () => {
  it('approves at the permission level the chat builds at, never a higher one', () => {
    expect(answer('allow', 'normal')).toEqual({
      outcome: { outcome: 'selected', optionId: 'proceed_once' }
    })
    expect(answer('allow', 'auto-medium')).toEqual({
      outcome: { outcome: 'selected', optionId: 'proceed_auto_run_medium' }
    })
    expect(answer('allow', 'auto-high')).toEqual({
      outcome: { outcome: 'selected', optionId: 'proceed_auto_run_high' }
    })
    expect(answer('deny', 'auto-high')).toEqual({
      outcome: { outcome: 'selected', optionId: 'cancel' }
    })
  })

  it('leaves tool permission requests to the generic card', () => {
    const edit = {
      ...specRequest,
      toolCall: { toolCallId: 'call_2', title: 'Create a.txt', kind: 'edit', rawInput: {} }
    }
    expect(droidSpecApproval('session/request_permission', edit)).toBeUndefined()
  })
})
