import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveCloneRepoNameFromUrl,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from './repo-clone-path'

describe('repo clone path helpers', () => {
  it.each([
    'git@example.com:project.git',
    'example.com:project.git',
    'git@[2001:db8::1]:project.git',
    '[2001:db8::1]:project.git',
    'git@example.com:team/project.git',
    'git@example.com:/srv/project.git'
  ])('derives the repository directory from the path in %s', (url) => {
    expect(deriveCloneRepoNameFromUrl(url)).toBe('project')
    expect(deriveValidatedClonePath({ url, destination: process.cwd() })).toBe(
      join(process.cwd(), 'project')
    )
  })

  it.each([
    'https://example.com/team/project.git',
    'ssh://git@example.com/team/project.git',
    '/srv/project.git',
    'C:\\repos\\project.git',
    'C:/repos/project.git',
    '\\\\server\\share\\project.git'
  ])('preserves repository names for URL and local path inputs: %s', (url) => {
    expect(deriveCloneRepoNameFromUrl(url)).toBe('project')
  })

  it('preserves a colon in an explicitly local relative path', () => {
    expect(deriveCloneRepoNameFromUrl('./local:project.git')).toBe('local:project')
  })

  it.each(['git@example.com:.', 'git@example.com:..'])(
    'rejects an unsafe repository basename in %s',
    (url) => {
      expect(() => deriveCloneRepoNameFromUrl(url)).toThrow('Invalid repository name')
    }
  )

  it('allows safe repository names that start with two dots', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'orca-clone-path-'))
    try {
      expect(
        deriveValidatedClonePath({
          url: 'https://example.com/..repo.git',
          destination
        })
      ).toBe(join(destination, '..repo'))
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })

  it('rejects Windows-looking destinations on non-Windows hosts', async () => {
    if (process.platform === 'win32') {
      return
    }
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: 'C:\\Users\\me\\src'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '\\\\server\\share'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '//server/share'
      })
    ).toThrow('Clone destination must be an absolute path')
    expect(() =>
      deriveValidatedClonePath({
        url: 'https://example.com/orca.git',
        destination: '//wsl.localhost/Ubuntu/home/me'
      })
    ).toThrow('Clone destination must be an absolute path')
  })

  it('canonicalizes WSL UNC server aliases without folding Linux path casing', () => {
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo')).toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\User\\repo')
    )
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo\\')).toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\User\\repo')
    )
    expect(getClonePathComparisonKey('\\\\wsl.localhost\\Ubuntu\\home\\User\\repo')).not.toBe(
      getClonePathComparisonKey('\\\\wsl$\\ubuntu\\home\\user\\repo')
    )
  })
})
