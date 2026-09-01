import { describe, expect, it } from 'vitest'
import { WorktreeCreate } from './worktree-create-schemas'
import { WorktreeActivate, WorktreeSet } from './worktree-schemas'

describe('worktree RPC schemas', () => {
  it('accepts optional display-name provenance values', () => {
    expect(
      WorktreeCreate.parse({ repo: 'repo-1', name: 'feature', displayNameKind: 'user' })
    ).toMatchObject({ displayNameKind: 'user' })
    expect(
      WorktreeCreate.parse({ repo: 'repo-1', name: 'feature', displayNameKind: 'generated' })
    ).toMatchObject({ displayNameKind: 'generated' })
  })

  it('validates additive navigation intent', () => {
    expect(WorktreeActivate.parse({ worktree: 'id:wt-1', navigation: 'clients' }).navigation).toBe(
      'clients'
    )
    expect(
      WorktreeActivate.safeParse({ worktree: 'id:wt-1', navigation: 'everyone' }).success
    ).toBe(false)
  })

  it('rejects invalid startup agent values', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'agent-startup',
      startupAgent: 'wat',
      startupPrompt: 'hi'
    })

    expect(parsed.success).toBe(false)
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

  it('parses optional GitHub PR suppression writes and clears', () => {
    expect(
      WorktreeSet.parse({ worktree: 'id:r1::/repos/wt', suppressedGitHubPR: 42 }).suppressedGitHubPR
    ).toBe(42)
    expect(
      WorktreeSet.parse({ worktree: 'id:r1::/repos/wt', suppressedGitHubPR: null })
        .suppressedGitHubPR
    ).toBeNull()
    expect(
      WorktreeSet.safeParse({ worktree: 'id:r1::/repos/wt', suppressedGitHubPR: 0 }).success
    ).toBe(false)
  })
})

describe('linked Odoo ticket ids', () => {
  it.each([
    ['create', WorktreeCreate, { repo: 'repo-1', name: 'wt' }],
    ['update', WorktreeSet, { worktree: 'id:wt-1' }]
  ])('rejects non-positive and fractional ids on the %s path', (_label, schema, base) => {
    // Odoo `project.task` ids are positive integers.
    expect(schema.safeParse({ ...base, linkedOdooTicket: 72 }).success).toBe(true)
    expect(schema.safeParse({ ...base, linkedOdooTicket: null }).success).toBe(true)
    expect(schema.safeParse({ ...base, linkedOdooTicket: 0 }).success).toBe(false)
    expect(schema.safeParse({ ...base, linkedOdooTicket: -5 }).success).toBe(false)
    expect(schema.safeParse({ ...base, linkedOdooTicket: 7.5 }).success).toBe(false)
  })
})

describe('linked Odoo work item over RPC', () => {
  // Why here and not in the live proof: the button's path was proven against a
  // real server on the renderer side, but the RPC schema graph is main-only and
  // the web project cannot import it. This is the remote/CLI half of that proof.
  const linkedWorkItem = {
    provider: 'odoo' as const,
    type: 'issue' as const,
    number: 80,
    title: '#80 Fix empty password submit',
    url: 'http://localhost:8069/odoo/all-tasks/80',
    odooInstanceId: 'inst-a'
  }

  it('accepts an Odoo linked work item and keeps its instance', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'ticket-80',
      linkedWorkItem,
      telemetrySource: 'sidebar'
    })

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
    // The instance is what makes the ticket addressable; dropping it here would
    // bind the workspace to whichever instance happened to be selected.
    expect(parsed.success && parsed.data.linkedWorkItem?.odooInstanceId).toBe('inst-a')
  })

  it('still rejects a provider outside the known set', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'repo-1',
      name: 'ticket-80',
      linkedWorkItem: { ...linkedWorkItem, provider: 'bitbucket' },
      telemetrySource: 'sidebar'
    })

    // The same rejection issue #11 reported for Odoo — the guard still bites, it
    // just no longer bites a provider the type union actually allows.
    expect(parsed.success).toBe(false)
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toContain(
      'Invalid linked work item'
    )
  })
})
