import { describe, expect, it } from 'vitest'
import {
  applyManualWorkspaceName,
  applySourceWorkspaceName,
  clearSourceWorkspaceName
} from './workspace-source-name-state'

describe('workspace source name ownership', () => {
  it('lets source suggestions replace blank/source names but never manual edits', () => {
    const first = applySourceWorkspaceName({ value: '', owner: 'blank' }, 'issue-8').state
    expect(first).toEqual({ value: 'issue-8', owner: 'source' })
    const manual = applyManualWorkspaceName(first, 'issue-8')
    expect(manual.owner).toBe('user')
    expect(applySourceWorkspaceName(manual, 'issue-9').state).toBe(manual)
  })

  it('clears only source-owned names', () => {
    expect(clearSourceWorkspaceName({ value: 'auto', owner: 'source' })).toEqual({
      value: '',
      owner: 'blank'
    })
    expect(clearSourceWorkspaceName({ value: 'mine', owner: 'user' })).toEqual({
      value: 'mine',
      owner: 'user'
    })
  })
})
