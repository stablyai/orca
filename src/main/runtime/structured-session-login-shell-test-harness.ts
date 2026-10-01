/**
 * A structured session's child env beside a HOME whose login profiles put a stand-in global `orca`
 * first, as `/usr/local/bin` often is. Shared by the bash suite (every lane) and the zsh suite
 * (the real-shell lane, which installs zsh).
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { runProcess } from '../../shared/child-process/run-process'
import { structuredSessionChildIdentityEnv } from './structured-session-child-identity-env'

const SESSION_ID = 'f7a1c0de-1111-4222-8333-444455556666'

export type LoginShellHarness = {
  /** Runs a shell with the structured session's env and returns its stdout. */
  run: (spec: { program: string; args: [flag: '-lc' | '-c', script: string] }) => Promise<string>
  dispose: () => void
}

function writeStub(path: string, says: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${says}'\n`)
  chmodSync(path, 0o755)
}

export function createLoginShellHarness(): LoginShellHarness {
  const root = mkdtempSync(join(tmpdir(), 'orca-login-shell-cli-'))
  const home = join(root, 'home')
  const globalBin = join(root, 'global-bin')
  const userData = join(root, 'user-data')
  const appCliBin = join(userData, 'cli', 'bin')
  for (const dir of [home, globalBin, appCliBin]) {
    mkdirSync(dir, { recursive: true })
  }
  writeStub(join(globalBin, 'orca'), 'global')
  writeStub(join(appCliBin, 'orca'), 'app')
  writeStub(join(appCliBin, 'orca-dev'), 'app')
  const prependGlobal = `export PATH="${globalBin}:$PATH"\n`
  writeFileSync(join(home, '.zprofile'), prependGlobal)
  writeFileSync(join(home, '.bash_profile'), prependGlobal)
  installFakeAppEnvironment({ isPackaged: () => false, getPath: () => userData })
  const env = structuredSessionChildIdentityEnv(SESSION_ID, { HOME: home, PATH: '/usr/bin:/bin' })
  return {
    run: async (spec) => (await runProcess({ ...spec, env })).stdout,
    dispose: () => rmSync(root, { recursive: true, force: true })
  }
}
