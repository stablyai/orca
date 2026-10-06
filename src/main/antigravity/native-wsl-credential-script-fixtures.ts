import { mkdtemp, mkdir, chmod, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { buildAntigravityWslCredentialCommand } from './native-wsl-credential-script'
import { encodeAntigravityWslWrite } from './native-wsl-credential-protocol'

export async function wslScriptFixture() {
  const home = await mkdtemp(join(homedir(), '.orca-agy-guest-test-'))
  const directory = join(home, '.gemini', 'antigravity-cli')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const path = join(directory, 'antigravity-oauth-token')
  const authority = {
    distro: 'Ubuntu',
    uid: process.getuid?.() ?? 0,
    home,
    canonicalHome: home,
    authorityId: 'a'.repeat(64),
    credentialPath: path
  }
  return {
    home,
    path,
    directory,
    authority,
    put: (contents: string, mode = 0o600) => writeFile(path, contents, { mode }),
    clean: () => rm(home, { recursive: true, force: true }),
    async run(
      action: 'read' | 'write',
      contents = '',
      expected: string | null = null,
      prefix = ''
    ) {
      const command = buildAntigravityWslCredentialCommand(action, authority, 'abc123')
      if (command.script === undefined) {
        throw new Error('Expected guest script')
      }
      return runProcess({
        program: '/bin/sh',
        args: ['-c', prefix + command.script, '--', ...(command.args ?? [])],
        env: { ...process.env, HOME: home, WSL_DISTRO_NAME: 'Ubuntu' },
        input: action === 'write' ? encodeAntigravityWslWrite(contents, expected) : undefined,
        timeoutMs: 5000,
        maxOutputBytes: 192 * 1024,
        killOnOutputLimit: true
      })
    }
  }
}
