import { describe, expect, it } from 'vitest'
import { resolveRepoAddHostId } from './repo-add-host'
import { RuntimeClientError } from './runtime-client'

describe('resolveRepoAddHostId', () => {
  it('accepts canonical execution host ids', () => {
    expect(resolveRepoAddHostId('local')).toBe('local')
    expect(resolveRepoAddHostId('ssh:ssh-1784350275544-cv3c0t')).toBe(
      'ssh:ssh-1784350275544-cv3c0t'
    )
    expect(resolveRepoAddHostId('runtime:gpu')).toBe('runtime:gpu')
  })

  it('accepts bare SSH connectionIds from repo list output', () => {
    expect(resolveRepoAddHostId('ssh-1784350275544-cv3c0t')).toBe('ssh:ssh-1784350275544-cv3c0t')
  })

  it('rejects unknown host selectors with an --environment hint', () => {
    expect(() => resolveRepoAddHostId('env:something')).toThrow(RuntimeClientError)
    try {
      resolveRepoAddHostId('env:something')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeClientError)
      expect((error as RuntimeClientError).message).toContain('--environment')
      expect((error as RuntimeClientError).message).toContain('ssh:<connectionId>')
    }
  })
})
