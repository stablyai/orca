import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform/external-links/external-link', () => ({ openExternalLink: vi.fn() }))
import {
  connectorLinkTarget,
  GITHUB_LINK_HOSTS,
  GOOGLE_LINK_HOSTS,
  requireConnectorLink,
  SLACK_LINK_HOSTS
} from './connector-link'

describe('connectorLinkTarget', () => {
  it('refuses non-https schemes and malformed URLs', () => {
    expect(connectorLinkTarget('http://github.com/apps/orca')).toBeNull()
    expect(connectorLinkTarget('javascript:alert(1)')).toBeNull()
    expect(connectorLinkTarget('intent://x#Intent;end')).toBeNull()
    expect(connectorLinkTarget('not a url')).toBeNull()
    expect(connectorLinkTarget('')).toBeNull()
  })

  it('refuses hosts outside the provider, including lookalikes and credentials', () => {
    expect(connectorLinkTarget('https://evil.example/', GITHUB_LINK_HOSTS)).toBeNull()
    expect(connectorLinkTarget('https://github.com.evil.example/', GITHUB_LINK_HOSTS)).toBeNull()
    expect(connectorLinkTarget('https://notgithub.com/', GITHUB_LINK_HOSTS)).toBeNull()
    expect(connectorLinkTarget('https://github.com@evil.example/', GITHUB_LINK_HOSTS)).toBeNull()
    expect(connectorLinkTarget('https://user:pw@github.com/', GITHUB_LINK_HOSTS)).toBeNull()
  })

  it('accepts https on the provider host and its subdomains', () => {
    expect(
      connectorLinkTarget('https://github.com/apps/orca/installations/new', GITHUB_LINK_HOSTS)
    ).toBe('https://github.com/apps/orca/installations/new')
    expect(connectorLinkTarget('https://console.cloud.google.com/apis', GOOGLE_LINK_HOSTS)).toBe(
      'https://console.cloud.google.com/apis'
    )
    expect(connectorLinkTarget('https://backend.composio.dev/connect?x=1')).toBe(
      'https://backend.composio.dev/connect?x=1'
    )
  })

  it('keeps Slack authorize links on slack.com', () => {
    expect(connectorLinkTarget('https://slack.com/oauth/v2/authorize?x=1', SLACK_LINK_HOSTS)).toBe(
      'https://slack.com/oauth/v2/authorize?x=1'
    )
    expect(connectorLinkTarget('https://slack.com.evil.example/oauth', SLACK_LINK_HOSTS)).toBeNull()
  })

  it('throws on a refused link so callers can report it', () => {
    expect(() => requireConnectorLink('http://backend.composio.dev/x')).toThrow()
    expect(() => requireConnectorLink('https://backend.composio.dev/x')).not.toThrow()
  })
})
