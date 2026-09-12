import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildWslLauncher } from './wsl-cli-scripts'

const WIN_LAUNCHER = 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'

let stubDir: string

/** Runs the generated launcher and returns the WSLENV its Windows child actually receives. */
function forwardedWslenv(wslenv: string | undefined): string {
  const env: NodeJS.ProcessEnv = { PATH: `${stubDir}:${process.env.PATH ?? ''}` }
  if (wslenv !== undefined) {
    env.WSLENV = wslenv
  }
  return execFileSync('bash', ['-c', buildWslLauncher(WIN_LAUNCHER)], { encoding: 'utf8', env })
}

// Why: the launcher only ever runs inside a WSL distro, and exercising it needs bash, executable
// /bin/sh stubs, and a colon-separated PATH — none of which a native Windows checkout provides.
describe.skipIf(process.platform === 'win32')('buildWslLauncher WSLENV sanitization', () => {
  // Why: stubbing the two interop tools on PATH lets these run the shipped launcher unmodified
  // instead of asserting against a rewritten copy of it.
  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'orca-wsl-launcher-'))
    writeFileSync(join(stubDir, 'wslpath'), '#!/bin/sh\nprintf "C:\\\\stub"\n', { mode: 0o755 })
    writeFileSync(join(stubDir, 'powershell.exe'), '#!/bin/sh\nprintf "%s" "${WSLENV-<unset>}"\n', {
      mode: 0o755
    })
  })

  afterAll(() => {
    rmSync(stubDir, { recursive: true, force: true })
  })

  // Why: WSLENV forwards the Linux PATH as "PATH" next to the Windows "Path" the child already
  // has, and the launcher rejects the case-insensitive duplicate before the CLI starts.
  it('drops a PATH entry so the Windows child never sees a duplicate key', () => {
    expect(forwardedWslenv('PATH/l')).toBe('')
    expect(forwardedWslenv('PATH')).toBe('')
  })

  it('drops PATH regardless of case or share flags', () => {
    expect(forwardedWslenv('Path/l')).toBe('')
    expect(forwardedWslenv('pAtH/up')).toBe('')
    expect(forwardedWslenv('PATH/l:Path:pAtH/u')).toBe('')
  })

  it('keeps every other entry in its original order', () => {
    expect(forwardedWslenv('GIT_TERMINAL_PROMPT:ORCA_TAB_ID/u')).toBe(
      'GIT_TERMINAL_PROMPT:ORCA_TAB_ID/u'
    )
    expect(forwardedWslenv('ORCA_TAB_ID/u:PATH/l:ORCA_WORKTREE_ID/u')).toBe(
      'ORCA_TAB_ID/u:ORCA_WORKTREE_ID/u'
    )
    expect(forwardedWslenv('PATH/l:ORCA_USER_DATA_PATH/p')).toBe('ORCA_USER_DATA_PATH/p')
  })

  it('keeps variables that merely contain PATH in their name', () => {
    expect(forwardedWslenv('PATHFINDER/u')).toBe('PATHFINDER/u')
    expect(forwardedWslenv('MY_PATH/u:PATH/l:PATH_EXTRA')).toBe('MY_PATH/u:PATH_EXTRA')
  })

  it('collapses empty segments instead of forwarding them', () => {
    expect(forwardedWslenv('A::B')).toBe('A:B')
    expect(forwardedWslenv(':A:')).toBe('A')
  })

  it('survives an unset or empty WSLENV under set -u', () => {
    expect(forwardedWslenv(undefined)).toBe('')
    expect(forwardedWslenv('')).toBe('')
  })
})
