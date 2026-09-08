import { describe, expect, it, vi } from 'vitest'
import { resolveGitStatusUpstreamRef } from './status-upstream-ref'

const signal = (): AbortSignal => new AbortController().signal
const metadata = (ref: string, remote = 'origin') => ({
  stdout: `${ref}\0=\0refs/heads/feature\0${remote}\0refs/heads/feature\n`
})

describe('resolveGitStatusUpstreamRef', () => {
  it.each(['refs/remotes/team/fork/feature', 'refs/custom/feature', 'refs/heads/tracking/feature'])(
    'retains host-owned remote tracking ref %s for old publishers',
    async (ref) => {
      const exec = vi.fn().mockResolvedValue(metadata(ref))
      const label = ref.replace(/^refs\/(remotes|heads)\//, '')
      expect(
        await resolveGitStatusUpstreamRef(exec, '/repo', 'refs/heads/feature', label, signal())
      ).toBe(ref)
      expect(exec).toHaveBeenCalledOnce()
    }
  )
  it('corroborates explicit canonical metadata against the configured fetch mapping', async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => ({
      stdout: args[0] === 'config' ? '+refs/heads/*:refs/custom/fork/*' : 'oid'
    }))
    const identity = {
      selector: { kind: 'named-remote' as const, value: 'fork' },
      mergeRef: 'refs/heads/feature',
      trackingRef: 'refs/custom/fork/feature'
    }
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'unrelated/display',
        signal(),
        identity.trackingRef,
        identity
      )
    ).toBe(identity.trackingRef)
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'unrelated/display',
        signal(),
        'refs/remotes/fork/feature',
        identity
      )
    ).toBeUndefined()
  })
  it('resolves legacy overrides through configured fetch mappings', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/main\0=\0refs/heads/feature\0origin\0refs/heads/main\n'
      })
      .mockResolvedValueOnce({ stdout: '+refs/heads/*:refs/custom/origin/*' })
      .mockResolvedValueOnce({ stdout: 'oid' })
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'refs/custom/origin/feature',
        signal()
      )
    ).toBe('refs/custom/origin/feature')
  })
  it('excludes local upstream provenance regardless of namespace', async () => {
    const exec = vi.fn().mockResolvedValue(metadata('refs/heads/feature/base', '.'))
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'feature/base',
        signal()
      )
    ).toBeUndefined()
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'feature/base',
        signal(),
        'refs/custom/local',
        {
          selector: { kind: 'local' },
          mergeRef: 'refs/heads/feature',
          trackingRef: 'refs/custom/local'
        }
      )
    ).toBeUndefined()
  })
  it('rejects unsafe metadata without interpreting labels', async () => {
    const exec = vi.fn().mockResolvedValue(metadata('refs/remotes/origin/feature'))
    expect(
      await resolveGitStatusUpstreamRef(
        exec,
        '/repo',
        'refs/heads/feature',
        'origin/feature',
        signal(),
        'refs/../bad'
      )
    ).toBeUndefined()
  })
})
