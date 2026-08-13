import { describe, expect, it } from 'vitest'
import { WorktreeActivate, WorktreeCreate, WorktreeSet } from './worktree-schemas'

describe('worktree RPC schemas', () => {
  it('validates additive navigation intent', () => {
    expect(WorktreeActivate.parse({ worktree: 'id:wt-1', navigation: 'clients' }).navigation).toBe(
      'clients'
    )
    expect(
      WorktreeActivate.safeParse({ worktree: 'id:wt-1', navigation: 'everyone' }).success
    ).toBe(false)
  })

  it('rehomes a retired startup agent prompt as a draft instead of discarding it', () => {
    // A mixed-version client can still send startupAgent:'gemini' plus a prompt.
    // Dropping both silently created a plain shell and lost the task text.
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'gemini',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(true)
    expect(parsed.data?.startupAgent).toBeUndefined()
    expect(parsed.data?.startupPrompt).toBeUndefined()
    expect(parsed.data?.startupDraft).toBe('hi')
  })

  it('keeps an explicit draft when a retired startup agent also carried a prompt', () => {
    const parsed = WorktreeCreate.parse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'gemini',
      startupPrompt: 'prompt text',
      startupDraft: 'draft text'
    })

    expect(parsed.startupAgent).toBeUndefined()
    expect(parsed.startupPrompt).toBeUndefined()
    expect(parsed.startupDraft).toBe('draft text')
  })

  it('keeps a retired agent draft-only create as a draft create', () => {
    const parsed = WorktreeCreate.parse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'gemini',
      startupDraft: 'draft text'
    })

    expect(parsed.startupAgent).toBeUndefined()
    expect(parsed.startupDraft).toBe('draft text')
  })

  it('rejects an unknown startup agent id rather than degrading to a plain shell', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'not-an-agent',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
  })

  it('keeps a supported startup agent and its prompt', () => {
    const parsed = WorktreeCreate.parse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'claude',
      startupPrompt: 'hi'
    })

    expect(parsed.startupAgent).toBe('claude')
    expect(parsed.startupPrompt).toBe('hi')
  })

  it('rejects startup prompts without startup agents', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
  })

  it('normalizes durable Jira linked-item metadata and rejects provider mismatches', () => {
    const linkedWorkItem = {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: ' ORCA-123 Link Jira ',
      url: ' https://company.atlassian.net/browse/ORCA-123 ',
      jiraIdentifier: ' ORCA-123 '
    }
    const linkedTaskSourceContext = {
      kind: 'task-source',
      provider: 'jira',
      projectId: ' project-1 ',
      hostId: 'runtime:env-1',
      providerIdentity: {
        provider: 'jira',
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    }
    const parsed = WorktreeCreate.parse({
      repo: 'repo-1',
      name: 'jira-link',
      linkedWorkItem,
      linkedTaskSourceContext
    })

    expect(parsed.linkedWorkItem).toMatchObject({
      provider: 'jira',
      title: 'ORCA-123 Link Jira',
      jiraIdentifier: 'ORCA-123'
    })
    expect(parsed.linkedTaskSourceContext).toMatchObject({
      provider: 'jira',
      projectId: 'project-1',
      hostId: 'runtime:env-1'
    })
    expect(
      WorktreeCreate.safeParse({
        repo: 'repo-1',
        name: 'mismatch',
        linkedWorkItem,
        linkedTaskSourceContext: { ...linkedTaskSourceContext, provider: 'linear' }
      }).success
    ).toBe(false)
    expect(
      WorktreeCreate.safeParse({
        repo: 'repo-1',
        name: 'wrong-site',
        linkedWorkItem,
        linkedTaskSourceContext: {
          ...linkedTaskSourceContext,
          providerIdentity: {
            ...linkedTaskSourceContext.providerIdentity,
            siteUrl: 'https://other.atlassian.net'
          }
        }
      }).success
    ).toBe(false)
    expect(() =>
      WorktreeCreate.safeParse({
        repo: 'repo-1',
        name: 'malformed',
        linkedWorkItem,
        linkedTaskSourceContext: { ...linkedTaskSourceContext, accountLabel: 44 }
      })
    ).not.toThrow()
  })

  it('keeps a blanked display name on remote hosts instead of dropping the clear', () => {
    // Blanking sends displayName:'' meaning "fall back to the branch/folder name".
    // Coercing it to undefined made updateManagedWorktreeMeta's omitUndefinedProperties
    // drop the key, so an SSH/paired-web rename-to-blank silently kept the old name.
    const parsed = WorktreeSet.parse({ worktree: 'id:r1::/repos/wt', displayName: '' })

    expect(parsed.displayName).toBe('')
    expect(Object.hasOwn(parsed, 'displayName')).toBe(true)
  })

  it('still omits a display name that was never sent', () => {
    const parsed = WorktreeSet.parse({ worktree: 'id:r1::/repos/wt', comment: 'note' })

    expect(parsed.displayName).toBeUndefined()
    expect(Object.hasOwn(parsed, 'displayName')).toBe(false)
  })

  it('ignores a non-string display name rather than persisting it', () => {
    const parsed = WorktreeSet.parse({ worktree: 'id:r1::/repos/wt', displayName: 42 })

    expect(parsed.displayName).toBeUndefined()
  })
})
