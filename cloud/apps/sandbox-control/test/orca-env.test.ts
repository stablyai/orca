// orca-env (image/vm/orca-env): prints lines that bring a running shell up to date with the session
// env file. Values must survive quoting exactly (quotes, newlines, $, backslashes) in POSIX shells
// and fish, and names that were removed must be unset.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ORCA_ENV = fileURLToPath(new URL('../image/vm/orca-env', import.meta.url).href)

const TRICKY: Record<string, string> = {
  SINGLE: "it's a 'quoted' value",
  DOUBLE: 'say "hi" and \\"escaped\\"',
  DOLLAR: '$HOME $(touch /tmp/orca-env-pwned) `id` ${PATH}',
  NEWLINES: 'line one\nline two\n\n',
  BACKSLASH: 'C:\\path\\to\\ \\n not-a-newline \\',
  SEMI: 'a; echo pwned; b && c | d',
  EMPTY: ''
}

let dir = ''
let envFile = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-env-'))
  envFile = join(dir, 'session.env')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSessionEnv(values: Record<string, string>, extraLines: string[] = []): void {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${Buffer.from(value).toString('base64')}`)
  writeFileSync(envFile, [...lines, ...extraLines].join('\n') + '\n')
}

function orcaEnv(args: string[], names = ''): string {
  const result = spawnSync('bash', [ORCA_ENV, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ORCA_SESSION_ENV_FILE: envFile, ORCA_SESSION_ENV_NAMES: names }
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout
}

/** Runs `script` in `shell` and returns the env it ends with, read back as JSON through node. */
function envAfter(shell: string, args: string[], script: string, initial: Record<string, string> = {}) {
  const dump = `"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.env))'`
  const result = spawnSync(shell, ['-c', `${script}\n${dump}`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      // A throwaway HOME keeps this machine's rc files out of it.
      HOME: dir,
      ORCA_SESSION_ENV_FILE: envFile,
      ORCA_ENV_BIN: ORCA_ENV,
      ...initial
    }
  })
  expect(result.stderr, shell).toBe('')
  return JSON.parse(result.stdout) as Record<string, string>
}

function hasShell(shell: string): boolean {
  return !spawnSync(shell, ['-c', 'true']).error
}

describe('orca-env', () => {
  it('exports every session name with its exact value in bash, sh and zsh', () => {
    writeSessionEnv(TRICKY)
    for (const shell of ['bash', 'sh', 'zsh'].filter(hasShell)) {
      const env = envAfter(shell, [], 'eval "$(bash "$ORCA_ENV_BIN")"')
      for (const [name, value] of Object.entries(TRICKY)) {
        expect(env[name], `${shell} ${name}`).toBe(value)
      }
      expect(env.ORCA_SESSION_ENV_NAMES).toBe(Object.keys(TRICKY).join(' '))
    }
  })

  it('exports the exact values in fish', () => {
    if (!hasShell('fish')) {
      return
    }
    writeSessionEnv(TRICKY)
    const env = envAfter('fish', ['--fish'], 'bash $ORCA_ENV_BIN --fish | source')
    for (const [name, value] of Object.entries(TRICKY)) {
      expect(env[name], name).toBe(value)
    }
  })

  it('unsets names the session env no longer has, in POSIX shells and fish', () => {
    writeSessionEnv({ KEPT: 'new' })
    const initial = { KEPT: 'old', GONE: 'stale', MINE: 'untouched', ORCA_SESSION_ENV_NAMES: 'KEPT GONE' }
    expect(orcaEnv([], 'KEPT GONE')).toContain('unset GONE\n')
    expect(orcaEnv(['--fish'], 'KEPT GONE')).toContain('set -e GONE\n')
    const shells: [string, string][] = [['bash', 'eval "$(bash "$ORCA_ENV_BIN")"']]
    if (hasShell('fish')) {
      shells.push(['fish', 'bash $ORCA_ENV_BIN --fish | source'])
    }
    for (const [shell, script] of shells) {
      const env = envAfter(shell, [], script, initial)
      expect(env.KEPT, shell).toBe('new')
      expect(env.GONE, shell).toBeUndefined()
      expect(env.MINE, shell).toBe('untouched')
      expect(env.ORCA_SESSION_ENV_NAMES, shell).toBe('KEPT')
    }
  })

  it('skips names the shell hook skips and globs nothing', () => {
    writeSessionEnv({ GOOD: 'x' }, ['PATH=L3RtcA==', 'ORCA_X=eA==', 'LD_PRELOAD=eA==', 'lower=eA==', 'not a line'])
    const out = orcaEnv([], '* ORCA_TOKEN')
    expect(out).toBe("export GOOD='x'\nexport ORCA_SESSION_ENV_NAMES='GOOD'\n")
  })

  it('prints nothing before the session env exists and never writes a file', () => {
    const result = spawnSync('bash', [ORCA_ENV], {
      encoding: 'utf8',
      cwd: dir,
      env: { PATH: process.env.PATH, ORCA_SESSION_ENV_FILE: join(dir, 'missing'), ORCA_SESSION_ENV_NAMES: 'A B' }
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(spawnSync('ls', ['-A', dir], { encoding: 'utf8' }).stdout).toBe('')
  })

  it('rejects unknown options', () => {
    const result = spawnSync('bash', [ORCA_ENV, '--zsh'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
  })
})
