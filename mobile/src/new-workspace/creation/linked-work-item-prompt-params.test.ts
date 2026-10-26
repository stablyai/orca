import { describe, expect, it } from 'vitest'
import {
  buildTaskWorkspaceCreateParams,
  type WorkspaceCreateTaskItem
} from './workspace-create-params'

const items: WorkspaceCreateTaskItem[] = [
  {
    provider: 'github',
    source: { type: 'issue', repoId: 'repo-1', number: 1, title: 'Task', url: 'https://tasks.test/1' }
  },
  {
    provider: 'gitlab',
    source: { type: 'issue', repoId: 'repo-1', number: 1, title: 'Task', url: 'https://tasks.test/1' }
  },
  {
    provider: 'linear',
    source: { identifier: 'ENG-1', title: 'Task', url: 'https://tasks.test/1' }
  },
  { provider: 'jira', source: { key: 'ENG-1', title: 'Task', url: 'https://tasks.test/1' } }
]

describe('linked work item prompt templates', () => {
  it.each(items)('keeps the $provider custom prompt as an unsent draft', (item) => {
    const args = {
      item,
      targetRepoId: 'repo-1',
      setupDecision: 'inherit' as const,
      linkedWorkItemPromptTemplate: '{{url}} /ticket-skill'
    }
    const params = buildTaskWorkspaceCreateParams({ ...args, agent: 'codex' })
    expect(params.startupDraft).toBe('https://tasks.test/1 /ticket-skill')
    expect(params).not.toHaveProperty('prompt')
    expect(params).not.toHaveProperty('startupPrompt')
    expect(buildTaskWorkspaceCreateParams({ ...args, agent: 'blank' })).not.toHaveProperty(
      'startupDraft'
    )
  })
})
