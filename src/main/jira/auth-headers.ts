import type { JiraSite } from '../../shared/types'

export function basicAuthHeader(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`
}

export function jiraAuthorizationHeader(site: JiraSite, secret: string): string {
  if (site.deploymentType === 'server' && site.authMode === 'bearer') {
    return `Bearer ${secret}`
  }
  return basicAuthHeader(site.authUsername ?? site.email, secret)
}
