import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as CommandResolution from '../../shared/node-cli-command-resolution'
import { extractOAuthClientCredentials } from './gemini-install-discovery'

vi.mock('../../shared/node-cli-command-resolution', async (importOriginal) => {
  const original = await importOriginal<typeof CommandResolution>()
  return { ...original, resolveCliCommand: vi.fn(original.resolveCliCommand) }
})
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

it('discovers the client from a real installation without spawning PATH lookup subprocesses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-gemini-install-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), '', {
      mode: 0o755
    })
    const source = join(
      root,
      'node_modules',
      '@google',
      'gemini-cli-core',
      'dist',
      'src',
      'code_assist'
    )
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, 'oauth2.js'),
      "const OAUTH_CLIENT_ID = 'client'; const OAUTH_CLIENT_SECRET = 'secret';"
    )
    expect(await extractOAuthClientCredentials(root, bin)).toEqual({
      clientId: 'client',
      clientSecret: 'secret'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'discovers a symlinked ~/bin installation absent from GUI PATH',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-gemini-home-bin-'))
    try {
      const packageRoot = join(root, 'lib', 'gemini-cli')
      mkdirSync(join(root, 'bin'), { recursive: true })
      mkdirSync(join(packageRoot, 'bundle'), { recursive: true })
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@google/gemini-cli' })
      )
      writeFileSync(join(packageRoot, 'gemini.js'), '', { mode: 0o755 })
      writeFileSync(
        join(packageRoot, 'bundle', 'oauth.js'),
        "const OAUTH_CLIENT_ID = 'home-client'; const OAUTH_CLIENT_SECRET = 'home-secret';"
      )
      symlinkSync(join(packageRoot, 'gemini.js'), join(root, 'bin', 'gemini'))
      // Isolate the missing-PATH result from other installations on the test host.
      vi.mocked(resolveCliCommand).mockReturnValueOnce('gemini')
      expect(await extractOAuthClientCredentials(root, '')).toEqual({
        clientId: 'home-client',
        clientSecret: 'home-secret'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
