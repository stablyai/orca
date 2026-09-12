import { describe, expect, it } from 'vitest'
import { getOptionalJiraIssueLinkFlag, resolveJiraWorkItem } from './worktree-jira-issue-link'
import type { RuntimeClient } from '../runtime-client'
import type { JiraSite } from '../../shared/jira-types'

function flags(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('getOptionalJiraIssueLinkFlag', () => {
  it('is undefined when the flag is absent, so set leaves the link alone', () => {
    expect(getOptionalJiraIssueLinkFlag(flags({}), 'jira')).toBeUndefined()
  })

  it('accepts a bare issue key and leaves the site to the active one', () => {
    expect(getOptionalJiraIssueLinkFlag(flags({ jira: 'PROJ-123' }), 'jira')).toEqual({
      clear: false,
      issueKey: 'PROJ-123',
      parsed: null
    })
  })

  it('uppercases the key so proj-123 and PROJ-123 link the same issue', () => {
    expect(getOptionalJiraIssueLinkFlag(flags({ jira: 'proj-123' }), 'jira')).toMatchObject({
      issueKey: 'PROJ-123'
    })
  })

  it('pins the site when the value is a URL', () => {
    expect(
      getOptionalJiraIssueLinkFlag(
        flags({ jira: 'https://acme.atlassian.net/browse/PROJ-9' }),
        'jira'
      )
    ).toMatchObject({
      clear: false,
      issueKey: 'PROJ-9',
      parsed: { origin: 'https://acme.atlassian.net' }
    })
  })

  it('clears the link with null when the caller allows it', () => {
    expect(
      getOptionalJiraIssueLinkFlag(flags({ jira: 'null' }), 'jira', { allowNull: true })
    ).toEqual({
      clear: true
    })
  })

  it('rejects null where clearing makes no sense, like on create', () => {
    expect(() => getOptionalJiraIssueLinkFlag(flags({ jira: 'null' }), 'jira')).toThrow(
      /Omit --jira on create/
    )
  })

  it('rejects values that are neither a key nor an issue URL', () => {
    // Why: a bare project name or a Jira URL that is not an issue would
    // otherwise be stored as a key and render a dead link on the card.
    for (const bad of ['PROJ', 'not a key', 'https://acme.atlassian.net/projects/PROJ']) {
      expect(() => getOptionalJiraIssueLinkFlag(flags({ jira: bad }), 'jira')).toThrow(
        /Pass a Jira issue key/
      )
    }
  })

  it('rejects a flag passed without a value', () => {
    expect(() => getOptionalJiraIssueLinkFlag(flags({ jira: true }), 'jira')).toThrow(
      /Missing value for --jira/
    )
  })
})

const site = (id: string, siteUrl: string): JiraSite => ({ id, siteUrl }) as JiraSite

function clientWith(sites: JiraSite[], activeSiteId: string | null): RuntimeClient {
  return {
    call: async (method: string) => {
      if (method === 'jira.status') {
        return { result: { connected: true, sites, activeSiteId } }
      }
      return {
        result: {
          key: 'PROJ-9',
          title: 'A ticket',
          url: 'https://acme.atlassian.net/browse/PROJ-9',
          siteId: sites[0]?.id
        }
      }
    }
  } as unknown as RuntimeClient
}

describe('resolveJiraWorkItem site matching', () => {
  it('does not match a host that merely starts with the origin', async () => {
    // Why: the reported bug. A prefix test let acme.atlassian.net.evil.example
    // stand in for acme.atlassian.net.
    const input = getOptionalJiraIssueLinkFlag(
      flags({ jira: 'https://acme.atlassian.net/browse/PROJ-9' }),
      'jira'
    )
    const client = clientWith([site('1', 'https://acme.atlassian.net.evil.example')], '1')

    await expect(resolveJiraWorkItem(input, client)).rejects.toThrow(/No connected Jira site/)
  })

  it('matches the exact origin', async () => {
    const input = getOptionalJiraIssueLinkFlag(
      flags({ jira: 'https://acme.atlassian.net/browse/PROJ-9' }),
      'jira'
    )
    const client = clientWith([site('1', 'https://acme.atlassian.net')], '1')

    await expect(resolveJiraWorkItem(input, client)).resolves.toMatchObject({
      linkedWorkItem: { jiraIdentifier: 'PROJ-9' }
    })
  })

  it('refuses to guess when several sites are connected and none is active', async () => {
    const input = getOptionalJiraIssueLinkFlag(flags({ jira: 'PROJ-9' }), 'jira')
    const client = clientWith(
      [site('1', 'https://acme.atlassian.net'), site('2', 'https://other.atlassian.net')],
      null
    )

    await expect(resolveJiraWorkItem(input, client)).rejects.toThrow(/Several Jira sites/)
  })

  it('uses the only connected site when there is no active one', async () => {
    const input = getOptionalJiraIssueLinkFlag(flags({ jira: 'PROJ-9' }), 'jira')
    const client = clientWith([site('1', 'https://acme.atlassian.net')], null)

    await expect(resolveJiraWorkItem(input, client)).resolves.toMatchObject({
      linkedWorkItem: { jiraIdentifier: 'PROJ-9' }
    })
  })
})
