import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { deriveValidatedClonePath, getClonePathComparisonKey } from './repo-clone-path'

describe('repo clone path helpers', () => {
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
