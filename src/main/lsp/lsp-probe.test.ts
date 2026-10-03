import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { probeRepoLanguageServers, type LspProbeDeps } from './lsp-probe'

const repo: Repo = {
  id: 'r',
  path: '/repo',
  displayName: 'r',
  badgeColor: '#000000',
  addedAt: 0,
  languageServers: { enabled: { 'ruby-lsp': true, solargraph: true } }
}

function deps(overrides: Partial<LspProbeDeps> = {}): LspProbeDeps {
  return {
    loginShellEnv: async () => ({ PATH: '/shims' }),
    resolveOnPath: async (name) => (name === 'ruby-lsp' ? '/shims/ruby-lsp' : null),
    run: vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: '0.26.1\n',
      stderr: '',
      timedOut: false
    })),
    ...overrides
  }
}

describe('probeRepoLanguageServers', () => {
  it('reports bundled, installed and missing servers', async () => {
    expect(await probeRepoLanguageServers(repo, deps())).toEqual({
      typescript: { status: 'bundled' },
      'ruby-lsp': { status: 'installed', version: '0.26.1' },
      solargraph: { status: 'missing' }
    })
  })

  it('treats a failing --version (e.g. an rbenv shim without the gem) as missing', async () => {
    const result = await probeRepoLanguageServers(
      repo,
      deps({
        run: async () => ({
          code: 127,
          signal: null,
          stdout: '',
          stderr: 'rbenv: ruby-lsp: command not found',
          timedOut: false
        })
      })
    )
    expect(result['ruby-lsp']).toEqual({ status: 'missing' })
  })

  it('reports unsupported-host for remote repos without spawning', async () => {
    const d = deps()
    const result = await probeRepoLanguageServers({ ...repo, connectionId: 'ssh-1' }, d)
    expect(result['ruby-lsp']).toEqual({ status: 'unsupported-host' })
    expect(d.run).not.toHaveBeenCalled()
  })

  it('never runs the command of a server that is not enabled', async () => {
    const d = deps({ resolveOnPath: vi.fn(async (name: string) => `/shims/${name}`) })
    const result = await probeRepoLanguageServers(
      {
        ...repo,
        languageServers: {
          enabled: { solargraph: true },
          command: { 'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'] }
        }
      },
      d
    )
    expect(result['ruby-lsp']).toBeUndefined()
    expect(d.resolveOnPath).not.toHaveBeenCalledWith('bundle', expect.anything())
    expect(d.run).toHaveBeenCalledTimes(1)
    expect(d.run).not.toHaveBeenCalledWith(expect.objectContaining({ program: '/shims/bundle' }))
  })
})
