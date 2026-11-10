import { randomBytes } from '../transport/encryption/e2ee'

const SEGMENT = /^[A-Za-z0-9_.-]+$/

/** `owner/repo`, a github.com URL or its .git form, as the https URL the control plane clones; null otherwise. */
export function normalizeCloudRepoInput(input: string): string | null {
  const trimmed = input
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  const path = trimmed.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
  const parts = path.split('/')
  if (
    parts.length !== 2 ||
    !parts.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..')
  ) {
    return null
  }
  if (path === trimmed && /^[a-z]+:/i.test(trimmed)) {
    return null
  }
  return `https://github.com/${parts[0]}/${parts[1]}`
}

/** `<repo>-<8 hex>`: readable in every list, unique per create. */
export function cloudWorkspaceIdFor(repoUrl: string | null): string {
  const name = (repoUrl?.split('/').pop() ?? 'workspace')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 48)
  const suffix = Array.from(randomBytes(4), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${name}-${suffix}`
}
