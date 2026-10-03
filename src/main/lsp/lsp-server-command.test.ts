import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveLspServerCommand, type LspServerCommandDeps } from './lsp-server-command'

function deps(overrides: Partial<LspServerCommandDeps> = {}): LspServerCommandDeps {
  return {
    platform: 'darwin',
    loginShellEnv: async () => ({ PATH: '/shims:/usr/bin' }),
    resolveOnPath: vi.fn(async (name: string) => `/shims/${name}`),
    fileExists: async () => false,
    bundledTypescriptPaths: () => ({ cliPath: '/b/cli.mjs', tsserverPath: '/b/tsserver.js' }),
    ...overrides
  }
}

describe('resolveLspServerCommand', () => {
  it('runs the bundled TypeScript server through Electron-as-Node', async () => {
    const resolved = await resolveLspServerCommand('typescript', '/repo', undefined, deps())
    expect(resolved?.command.program).toBe(process.execPath)
    expect(resolved?.command.args).toEqual(['/b/cli.mjs', '--stdio'])
    expect(resolved?.command.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(resolved?.initializationOptions).toEqual({ tsserver: { path: '/b/tsserver.js' } })
  })

  it('prefers the project tsserver when it exists', async () => {
    const resolved = await resolveLspServerCommand(
      'typescript',
      '/repo',
      undefined,
      deps({ fileExists: async (p) => p.endsWith('tsserver.js') })
    )
    expect(resolved?.initializationOptions).toEqual({
      tsserver: { path: join('/repo', 'node_modules', 'typescript', 'lib', 'tsserver.js') }
    })
  })

  it('resolves ruby-lsp on the login-shell PATH from the project root', async () => {
    const d = deps()
    const resolved = await resolveLspServerCommand('ruby-lsp', '/repo', undefined, d)
    expect(d.resolveOnPath).toHaveBeenCalledWith('ruby-lsp', {
      env: { PATH: '/shims:/usr/bin' },
      cwd: '/repo',
      platform: 'darwin'
    })
    expect(resolved?.command).toEqual({
      program: '/shims/ruby-lsp',
      args: [],
      env: { PATH: '/shims:/usr/bin' }
    })
  })

  it('uses the custom argv override', async () => {
    const resolved = await resolveLspServerCommand(
      'ruby-lsp',
      '/repo',
      { command: { 'ruby-lsp': ['bundle', 'exec', 'ruby-lsp'] } },
      deps()
    )
    expect(resolved?.command.program).toBe('/shims/bundle')
    expect(resolved?.command.args).toEqual(['exec', 'ruby-lsp'])
  })

  it('returns null when the program is not on PATH', async () => {
    const resolved = await resolveLspServerCommand(
      'solargraph',
      '/repo',
      undefined,
      deps({ resolveOnPath: async () => null })
    )
    expect(resolved).toBeNull()
  })
})
