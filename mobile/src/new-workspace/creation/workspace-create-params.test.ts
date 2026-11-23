import { describe, expect, it } from 'vitest'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'

function clickUpParams(source: { id: string; customId?: string | null }, workspaceName?: string) {
  return buildTaskWorkspaceCreateParams({
    item: {
      provider: 'clickup',
      source: { name: 'Fix login', url: `https://app.clickup.com/t/${source.id}`, ...source }
    },
    targetRepoId: 'repo-1',
    setupDecision: 'skip',
    ...(workspaceName ? { workspaceName } : {})
  })
}

describe('ClickUp workspace name fallback', () => {
  it('uses the bare custom id when the task has one', () => {
    expect(clickUpParams({ id: '86abc12de', customId: 'ENG-7' }).name).toBe('eng-7')
  })

  it('prefixes a raw id the way ClickUp git linking does', () => {
    expect(clickUpParams({ id: '86ABC12DE', customId: null }).name).toBe('cu-86abc12de')
  })

  it('keeps the name the user typed', () => {
    expect(clickUpParams({ id: '86abc12de', customId: 'ENG-7' }, ' my-name ').name).toBe('my-name')
  })
})
