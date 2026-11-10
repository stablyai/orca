import { describe, expect, it } from 'vitest'
import { normalizeCloudRepoInput } from './cloud-repo-input'

describe('normalizeCloudRepoInput', () => {
  it('accepts owner/repo and github.com URLs', () => {
    expect(normalizeCloudRepoInput('stablyai/orca')).toBe('https://github.com/stablyai/orca')
    expect(normalizeCloudRepoInput('https://github.com/stablyai/orca.git')).toBe(
      'https://github.com/stablyai/orca'
    )
    expect(normalizeCloudRepoInput('github.com/stablyai/orca/')).toBe(
      'https://github.com/stablyai/orca'
    )
  })

  it('refuses other hosts, deeper paths and traversal', () => {
    expect(normalizeCloudRepoInput('https://gitlab.com/a/b')).toBeNull()
    expect(normalizeCloudRepoInput('stablyai/orca/tree/main')).toBeNull()
    expect(normalizeCloudRepoInput('../etc')).toBeNull()
    expect(normalizeCloudRepoInput('file://a/b')).toBeNull()
  })
})
