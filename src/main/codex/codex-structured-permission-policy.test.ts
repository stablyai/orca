import { describe, expect, it } from 'vitest'
import { codexStructuredPermissionPolicy } from './codex-structured-permission-policy'

const FULL_ACCESS = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  approvalsReviewer: 'user'
}
const ASK = { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' }

describe('codexStructuredPermissionPolicy', () => {
  it('maps Full access to no prompts and no sandbox', () => {
    expect(codexStructuredPermissionPolicy('full-access')).toEqual(FULL_ACCESS)
  })

  // The thread open spreads this, so an omitted field is absent, not reset: a thread resumed from
  // Full access would keep `never`. Ask states every field, the human reviewer too.
  it('states every Ask field, the human reviewer too', () => {
    expect(codexStructuredPermissionPolicy('ask')).toEqual(ASK)
  })

  it('routes Approve for me to Codex auto-review under the Ask sandbox', () => {
    expect(codexStructuredPermissionPolicy('auto')).toEqual({
      ...ASK,
      approvalsReviewer: 'auto_review'
    })
  })

  // A sandbox mode, never a `sandboxPolicy` object: Codex folds the user's own writable roots and
  // network access into a mode, and a policy object would replace them.
  it('names a sandbox mode for every mode', () => {
    for (const mode of ['ask', 'auto', 'full-access'] as const) {
      expect(codexStructuredPermissionPolicy(mode)).not.toHaveProperty('sandboxPolicy')
      expect(typeof codexStructuredPermissionPolicy(mode).sandbox).toBe('string')
    }
  })

  // Codex has no edits-only mode, so a stray one is the safer neighbour rather than more access.
  it('asks for a mode Codex does not have', () => {
    expect(codexStructuredPermissionPolicy('accept-edits')).toEqual(ASK)
  })
})
