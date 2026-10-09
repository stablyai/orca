import { describe, expect, it } from 'vitest'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

const BYPASS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user' as const
}
// Approvals on, writes confined to the workspace. Verified against codex 0.153.4: both values are
// accepted on thread/start and thread/resume, and the reply echoes them back as the effective
// policy even when the home's config.toml asks for `never` / `danger-full-access`.
const ASK = { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' }

describe('codexStructuredPermissionPolicy', () => {
  it('maps Full access to no prompts and no sandbox', () => {
    expect(codexStructuredPermissionPolicy('bypass')).toEqual(BYPASS)
  })

  // Why an explicit policy rather than nothing: the thread-open path spreads this, so nothing
  // means the fields are ABSENT, and absent is not a reset. A session flipped Yolo → Manual
  // resumed with the Yolo thread's `approvalPolicy: never` still in force and escalated with no
  // prompt. Ask has to say what it wants, reviewer included.
  it('states every Ask field, the human reviewer too', () => {
    const policy = codexStructuredPermissionPolicy('ask')
    expect(policy).toEqual(ASK)
    expect(Object.keys(policy)).toEqual(
      expect.arrayContaining(['approvalPolicy', 'sandbox', 'approvalsReviewer'])
    )
  })

  it('routes Approve for me to Codex auto-review under the Ask sandbox', () => {
    expect(codexStructuredPermissionPolicy('auto')).toEqual({
      ...ASK,
      approvalsReviewer: 'auto_review'
    })
  })

  // Codex has no edits-only mode, so a stray one is the safer neighbour rather than more access.
  it('asks for a mode Codex does not have', () => {
    expect(codexStructuredPermissionPolicy('accept-edits')).toEqual(ASK)
  })
})
