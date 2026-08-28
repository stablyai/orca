import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tryDeleteWslUncPath } from './wsl-unc-delete'

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

describe.skipIf(!runRealWsl)('WSL contained delete integration', () => {
  let fixtureRoot: string

  beforeAll(async () => {
    fixtureRoot = await wsl("mktemp -d -p /tmp 'orca-wsl-delete-real.XXXXXX'")
    await wsl(
      'mkdir -p "$1/vault" "$1/outside/file-parent" "$1/outside/dir-parent/session" "$1/vault/benign/session" && ' +
        'ln -s "$1/outside/file-parent" "$1/vault/file-link" && ' +
        'ln -s "$1/outside/dir-parent" "$1/vault/dir-link" && ' +
        'printf sentinel > "$1/outside/file-parent/session.json" && ' +
        'printf nested > "$1/outside/dir-parent/session/inside" && ' +
        'printf unrelated > "$1/outside/unrelated" && ' +
        'printf benign > "$1/vault/benign/session/inside"',
      fixtureRoot
    )
  })

  afterAll(async () => {
    if (/^\/tmp\/orca-wsl-delete-real\.[A-Za-z0-9]+$/u.test(fixtureRoot)) {
      await wsl('rm -rf -- "$1"', fixtureRoot)
    }
  })

  it.each([
    ['file-shaped', 'file-link/session.json', false],
    ['directory-shaped', 'dir-link/session', true]
  ])('rejects a %s escape and preserves all outside entries', async (_shape, path, recursive) => {
    const vaultRoot = `${fixtureRoot}/vault`

    await expect(
      tryDeleteWslUncPath(unc(`${vaultRoot}/${path}`), {
        recursive,
        approvedRoots: [unc(vaultRoot)]
      })
    ).rejects.toMatchObject({ reason: 'path-outside-known-roots' })

    await expect(
      wsl(
        'test -f "$1/outside/file-parent/session.json" && ' +
          'test -f "$1/outside/dir-parent/session/inside" && test -f "$1/outside/unrelated"',
        fixtureRoot
      )
    ).resolves.toBe('')
  })

  it('deletes a benign directory without touching an unrelated sentinel', async () => {
    const vaultRoot = `${fixtureRoot}/vault`

    await expect(
      tryDeleteWslUncPath(unc(`${vaultRoot}/benign/session`), {
        recursive: true,
        approvedRoots: [unc(vaultRoot)]
      })
    ).resolves.toBe(true)

    await expect(
      wsl('test ! -e "$1/vault/benign/session" && test -f "$1/outside/unrelated"', fixtureRoot)
    ).resolves.toBe('')
  })
})
