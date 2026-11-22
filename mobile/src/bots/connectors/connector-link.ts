import { withGoogleAccount } from '../../../../src/shared/google/google-console-setup'
import { openExternalLink } from '../../platform/external-links/external-link'

/** GitHub's install page, from the host's own URL. */
export function openGitHubLink(url: string): boolean {
  return openConnectorLink(url, GITHUB_LINK_HOSTS)
}

export const GITHUB_LINK_HOSTS = ['github.com']
export const SLACK_LINK_HOSTS = ['slack.com']
export const GOOGLE_LINK_HOSTS = ['google.com']

/** The normalized https URL when it is on one of `hosts` (or a subdomain); any https URL when `hosts` is omitted. */
export function connectorLinkTarget(url: string, hosts?: readonly string[]): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return null
  }
  if (
    hosts &&
    !hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
  ) {
    return null
  }
  return parsed.href
}

/** As openConnectorLink, but throws on a refused link so a caller's error handling reports it. */
export function requireConnectorLink(url: string, hosts?: readonly string[]): void {
  if (!openConnectorLink(url, hosts)) {
    throw new Error('connector_link_refused')
  }
}

/** Opens a host-supplied link only when it is https (and on `hosts`, when given); the host is paired but its URLs are not trusted. */
export function openConnectorLink(url: string, hosts?: readonly string[]): boolean {
  const target = connectorLinkTarget(url, hosts)
  if (!target) {
    console.warn('[bots] refused a connector link outside https or its provider host')
    return false
  }
  openExternalLink(target)
  return true
}

/** Google's Turn on link, signed in as `account`; the host's URL is checked before it is parsed again for the account. */
export function openGoogleConsoleLink(url: string, account: string | undefined): boolean {
  const target = connectorLinkTarget(url, GOOGLE_LINK_HOSTS)
  return target ? openConnectorLink(withGoogleAccount(target, account), GOOGLE_LINK_HOSTS) : false
}
