import { describe, expect, it } from 'vitest'
import {
  AutomationUpdate,
  TaskProviderIdentity,
  TaskSourceContext
} from '../../../../shared/rpc-contract/automation-params'
import type { TaskProviderIdentity as ProviderIdentity } from '../../../../shared/task-source-context'

const identities = [
  { provider: 'github', owner: 'Acme', repo: 'Orca', host: 'github.example.com' },
  {
    provider: 'gitlab',
    projectId: '123',
    namespace: 'acme/team',
    project: 'orca',
    webUrl: 'https://gitlab.example.com/acme/team/orca'
  },
  {
    provider: 'linear',
    workspaceId: 'workspace',
    workspaceName: 'Acme',
    teamId: 'team',
    teamKey: 'ENG'
  },
  { provider: 'jira', siteId: 'site', siteUrl: 'https://acme.atlassian.net', projectKey: 'ENG' }
] satisfies ProviderIdentity[]

describe('task provider identity RPC validation', () => {
  it.each(identities)('preserves valid $provider identities', (identity) => {
    expect(TaskProviderIdentity.parse(identity)).toEqual(identity)
  })

  it.each(['owner', 'repo'])('requires the GitHub %s', (field) => {
    const identity: Record<string, unknown> = { ...identities[0] }
    delete identity[field]
    expect(TaskProviderIdentity.safeParse(identity).success).toBe(false)
    expect(TaskProviderIdentity.safeParse({ ...identity, [field]: null }).success).toBe(false)
  })

  for (const identity of identities) {
    for (const field of Object.keys(identity).filter((key) => key !== 'provider')) {
      it.each([42, false, [], {}])(
        `rejects non-string ${identity.provider}.${field}: %j`,
        (value) => {
          expect(TaskProviderIdentity.safeParse({ ...identity, [field]: value }).success).toBe(
            false
          )
        }
      )
    }
  }

  it.each(['gitlab', 'linear', 'jira'])('keeps %s fields optional and nullable', (provider) => {
    expect(TaskProviderIdentity.parse({ provider })).toEqual({ provider })
    const full = identities.find((identity) => identity.provider === provider)!
    const nullable = Object.fromEntries(
      Object.keys(full).map((key) => [key, key === 'provider' ? provider : null])
    )
    expect(TaskProviderIdentity.parse(nullable)).toEqual(nullable)
  })

  it('preserves unknown fields and never infers GitHub from owner/repo', () => {
    const identity = { provider: 'gitlab', owner: 'acme', repo: 'orca', futureField: 'value' }
    expect(TaskProviderIdentity.parse(identity)).toEqual(identity)
  })

  it.each([{}, { provider: 'github' }, { provider: 'unknown' }, [], 'github', 1])(
    'rejects invalid identities: %j',
    (identity) => {
      expect(TaskProviderIdentity.safeParse(identity).success).toBe(false)
    }
  )

  it('preserves absent and explicit-null identities in folder contexts on local and SSH hosts', () => {
    expect(TaskProviderIdentity.parse(undefined)).toBeUndefined()
    expect(TaskProviderIdentity.parse(null)).toBeNull()
    for (const hostId of ['local', 'ssh:host']) {
      const context = { kind: 'task-source', provider: 'github', projectId: 'folder', hostId }
      expect(TaskSourceContext.parse(context)).not.toHaveProperty('providerIdentity')
      expect(TaskSourceContext.parse({ ...context, providerIdentity: null })).toEqual({
        ...context,
        providerIdentity: null
      })
    }
  })

  it('validates identities in automation updates without collapsing absent and null patches', () => {
    expect(AutomationUpdate.parse({ id: 'automation', updates: {} }).updates).not.toHaveProperty(
      'sourceContext'
    )
    expect(
      AutomationUpdate.parse({ id: 'automation', updates: { sourceContext: null } }).updates
        .sourceContext
    ).toBeNull()
    expect(
      AutomationUpdate.safeParse({
        id: 'automation',
        updates: {
          sourceContext: {
            kind: 'task-source',
            provider: 'github',
            projectId: 'project',
            hostId: 'local',
            providerIdentity: { provider: 'github' }
          }
        }
      }).success
    ).toBe(false)
  })
})
