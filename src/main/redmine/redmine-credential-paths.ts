import { homedir } from 'node:os'
import { join } from 'node:path'

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

export function getRedmineSiteFilePath(): string {
  return join(getOrcaDir(), 'redmine-sites.json')
}

export function getRedmineTokenDir(): string {
  return join(getOrcaDir(), 'redmine-tokens')
}

export function getRedmineTokenPath(siteId: string): string {
  return join(getRedmineTokenDir(), `${Buffer.from(siteId).toString('base64url')}.enc`)
}
