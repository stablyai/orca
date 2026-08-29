import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { containedDeleteCommand } from './wsl-contained-delete'
import { parseWslPath } from './wsl'

const execFileAsync = promisify(execFile)
const DISTRO = process.env.ORCA_WSL_TEST_DISTRO ?? 'Ubuntu-24.04'
const runRealWsl = process.platform === 'win32' && process.env.ORCA_REAL_WSL_DELETE_TEST === '1'

function unc(linuxPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${linuxPath.replaceAll('/', '\\')}`
}

async function wsl(command: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync(
    'wsl.exe',
    ['-d', DISTRO, '--exec', 'sh', '-c', command, 'orca-wsl-test', ...args],
    { encoding: 'utf-8', timeout: 30000 }
  )
  return result.stdout.trim()
}

describe.skipIf(!runRealWsl)('WSL approved-root traversal race', () => {
  let fixtureRoot: string

  beforeAll(async () => {
    fixtureRoot = await wsl("mktemp -d -p /tmp 'orca-wsl-root-race.XXXXXX'")
    const statHook = String.raw`#!/bin/sh
for argument do last=$argument; done
if [ "$PWD" = "$ORCA_RACE_PARENT" ] && [ "$(/usr/bin/basename "$last")" = vault ]; then
  inspected=$(/usr/bin/stat "$@") || exit $?
  /usr/bin/mv -- "$ORCA_RACE_PARENT/vault" "$ORCA_RACE_PARENT/vault-original" || exit $?
  /usr/bin/ln -s -- "$ORCA_RACE_OUTSIDE" "$ORCA_RACE_PARENT/vault" || exit $?
  printf '%s\n' "$inspected"
  exit 0
fi
exec /usr/bin/stat "$@"
`
    await wsl(
      'mkdir -p "$1/race/vault" "$1/execute-only/vault" "$1/outside/root-target" ' +
        '"$1/hook-bin" && ' +
        'printf approved > "$1/race/vault/session.json" && ' +
        'printf approved > "$1/execute-only/vault/session.json" && ' +
        'printf protected > "$1/outside/root-target/session.json" && ' +
        'printf unrelated > "$1/outside/unrelated" && ' +
        'chmod 111 "$1/execute-only" && ' +
        'printf %s "$2" > "$1/hook-bin/stat" && chmod +x "$1/hook-bin/stat"',
      fixtureRoot,
      statHook
    )
  })

  afterAll(async () => {
    if (/^\/tmp\/orca-wsl-root-race\.[A-Za-z0-9]+$/u.test(fixtureRoot)) {
      await wsl('chmod -f 700 "$1/execute-only" 2>/dev/null; rm -rf -- "$1"', fixtureRoot)
    }
  })

  it('fails closed when an approved-root component is replaced after inspection', async () => {
    const approvedRoot = `${fixtureRoot}/race/vault`
    const target = parseWslPath(unc(`${approvedRoot}/session.json`))
    const command = target
      ? containedDeleteCommand(target, [unc(approvedRoot)], parseWslPath, false)
      : null
    expect(command).not.toBeNull()

    await expect(
      execFileAsync(
        'wsl.exe',
        [
          '-d',
          DISTRO,
          '--exec',
          'env',
          `PATH=${fixtureRoot}/hook-bin:/usr/bin:/bin`,
          `ORCA_RACE_PARENT=${fixtureRoot}/race`,
          `ORCA_RACE_OUTSIDE=${fixtureRoot}/outside/root-target`,
          ...(command ?? [])
        ],
        { encoding: 'utf-8', timeout: 30000 }
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining('ORCA_WSL_DELETE_REJECT:race') })

    await expect(
      wsl(
        'test -f "$1/outside/root-target/session.json" && ' +
          'test -f "$1/race/vault-original/session.json" && test -f "$1/outside/unrelated"',
        fixtureRoot
      )
    ).resolves.toBe('')
  })

  it('allows an approved root beneath an execute-only ancestor', async () => {
    const approvedRoot = `${fixtureRoot}/execute-only/vault`
    const target = parseWslPath(unc(`${approvedRoot}/session.json`))
    const command = target
      ? containedDeleteCommand(target, [unc(approvedRoot)], parseWslPath, false)
      : null
    expect(command).not.toBeNull()

    try {
      await expect(
        execFileAsync('wsl.exe', ['-d', DISTRO, '--exec', ...(command ?? [])], {
          encoding: 'utf-8',
          timeout: 30000
        })
      ).resolves.toMatchObject({ stderr: '' })
      await expect(
        wsl(
          'test ! -e "$1/execute-only/vault/session.json" && test -f "$1/outside/unrelated"',
          fixtureRoot
        )
      ).resolves.toBe('')
    } finally {
      await wsl('chmod 700 "$1/execute-only"', fixtureRoot)
    }
  })
})
