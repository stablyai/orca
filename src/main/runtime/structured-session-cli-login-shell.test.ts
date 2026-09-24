/**
 * A provider can run every command in a login shell: Codex runs `/bin/zsh -lc <command>`. The
 * login profile rebuilds PATH — macOS's path_helper, a user's `.zprofile` — so the directory Orca
 * prepended ends up behind a global install, and bare `orca` becomes that install, possibly an
 * older Orca. `ORCA_CLI_COMMAND` names this app's launcher by absolute path, which no startup file
 * can reorder. Real shells, with a profile that puts a stand-in global `orca` first.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { runProcess } from '../../shared/child-process/run-process'
import { structuredSessionChildIdentityEnv } from './structured-session-child-identity-env'

const SESSION_ID = 'f7a1c0de-1111-4222-8333-444455556666'

function writeStub(path: string, says: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${says}'\n`)
  chmodSync(path, 0o755)
}

describe.runIf(process.platform !== 'win32')('a structured session in a login shell', () => {
  let root: string
  let env: Record<string, string>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-login-shell-cli-'))
    const home = join(root, 'home')
    const globalBin = join(root, 'global-bin')
    const userData = join(root, 'user-data')
    const appCliBin = join(userData, 'cli', 'bin')
    for (const dir of [home, globalBin, appCliBin]) {
      mkdirSync(dir, { recursive: true })
    }
    // A global install that the user's profile puts first, as `/usr/local/bin` often is.
    writeStub(join(globalBin, 'orca'), 'global')
    writeStub(join(appCliBin, 'orca'), 'app')
    writeStub(join(appCliBin, 'orca-dev'), 'app')
    const prependGlobal = `export PATH="${globalBin}:$PATH"\n`
    writeFileSync(join(home, '.zprofile'), prependGlobal)
    writeFileSync(join(home, '.bash_profile'), prependGlobal)
    installFakeAppEnvironment({ isPackaged: () => false, getPath: () => userData })
    env = structuredSessionChildIdentityEnv(SESSION_ID, { HOME: home, PATH: '/usr/bin:/bin' })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function run(shell: string, script: string): Promise<string> {
    const result = await runProcess({ program: shell, args: ['-lc', script], env })
    return result.stdout
  }

  it.each(['/bin/zsh', '/bin/bash'])(
    "resolves this app's CLI through ORCA_CLI_COMMAND in `%s -lc`",
    async (shell) => {
      // Positive control: the profile really does put the global install first for a bare name.
      expect(await run(shell, 'orca')).toBe('global')
      expect(await run(shell, '"$ORCA_CLI_COMMAND"')).toBe('app')
    }
  )

  it("keeps bare `orca` this app's CLI in a shell that reads no login profile", async () => {
    const result = await runProcess({ program: '/bin/zsh', args: ['-c', 'orca'], env })
    expect(result.stdout).toBe('app')
  })
})
