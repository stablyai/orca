import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { E2EE_KEYPAIR_FILENAME } from '../../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import { readWslAccountFacts, WSL_ACCOUNT_FACTS_COMMAND } from '../orcad/wsl-orcad-account-facts'
import { wslAccountKeysCommand } from './wsl-host-account-migration'
import { orcadPublicKeyCommand } from './wsl-host-ssh-orcad-conflict'

const PUBLIC = 'UFVCTElDLWtleS1iYXNlNjQtUFVCTElDLWtleS0xMjM='
const SECRET = 'U0VDUkVULWtleS1iYXNlNjQtU0VDUkVULWtleS0xMjM='
const keypair = { secretKeyB64: SECRET, publicKeyB64: PUBLIC, createdAt: 1 }
const LAYOUTS = {
  'pretty-printed': `${JSON.stringify(keypair, null, 2)}\n`,
  'single-line': JSON.stringify(keypair)
}

// Every snippet that reads an orcad key file must print the public key and nothing else (#49180).
describe.skipIf(process.platform === 'win32')('reading an orcad key file in the distro', () => {
  const dirs: string[] = []
  afterEach(async () => await removeTempDirs(dirs.splice(0)))

  function home(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wsl-key-'))
    dirs.push(dir)
    mkdirSync(join(dir, '.orca'))
    writeFileSync(join(dir, '.orca', E2EE_KEYPAIR_FILENAME), contents)
    return dir
  }

  const run = (command: string, env: NodeJS.ProcessEnv = {}): string =>
    execFileSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, ...env } })

  for (const [layout, contents] of Object.entries(LAYOUTS)) {
    it(`prints only the public key from a ${layout} file`, () => {
      const dir = home(contents)
      // The Add-time SSH conflict read and the facts probe's key line.
      expect(run(orcadPublicKeyCommand('$HOME'), { HOME: dir }).trim()).toBe(PUBLIC)
      const [userLine = '', keyLine = '', peerLine = ''] = run(WSL_ACCOUNT_FACTS_COMMAND, {
        HOME: dir
      }).split('\n')
      expect(readWslAccountFacts(userLine, keyLine, peerLine)?.ownKey).toBe(PUBLIC)
      // The root probe over every account's home.
      const passwd = `printf '%s\\n' 'alice:x:1000:1000::${dir}:/bin/sh'`
      const keys = run(wslAccountKeysCommand(passwd))
      expect(keys).toBe(`alice ${PUBLIC}\n`)
      expect(keys).not.toContain(SECRET)
    })
  }
})
