import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildWslLoginShellCommand, buildWslExecArgs } from '../shared/wsl-login-shell-command'
import { getLocalWorktreePathAccess } from './local-worktree-filesystem'

const execFileAsync = promisify(execFile)
const DISTRO = process.env.ORCA_WSL_TEST_DISTRO ?? 'Ubuntu-24.04'
const runRealWsl = process.platform === 'win32' && process.env.ORCA_REAL_WSL_BANNER_TEST === '1'

const FILE_CONTENTS = 'line one\nline two\n'

function unc(linuxPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${linuxPath.replaceAll('/', '\\')}`
}

async function wsl(command: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'wsl.exe',
    ['-d', DISTRO, '--exec', 'sh', '-c', command, 'orca-wsl-test', ...args],
    { encoding: 'utf-8', timeout: 30000 }
  )
  return stdout.trim()
}

/** What an unfenced login-shell read returns — the shape this suite exists to rule out. */
async function readThroughRawLoginShell(linuxPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'wsl.exe',
    buildWslExecArgs(DISTRO, ['sh', '-lc', buildWslLoginShellCommand(`cat -- '${linuxPath}'`)]),
    { encoding: 'utf-8', timeout: 30000 }
  )
  return stdout
}

describe.skipIf(!runRealWsl)('WSL worktree reads carry no shell chatter', () => {
  let fixtureRoot: string

  beforeAll(async () => {
    fixtureRoot = await wsl("mktemp -d -p /tmp 'orca-wsl-banner.XXXXXX'")
    await wsl('mkdir -p "$1/dir" && printf \'%s\' "$2" > "$1/file.txt"', fixtureRoot, FILE_CONTENTS)
  }, 120_000)

  afterAll(async () => {
    if (/^\/tmp\/orca-wsl-banner\.[A-Za-z0-9]+$/u.test(fixtureRoot)) {
      await wsl('rm -rf -- "$1"', fixtureRoot)
    }
  }, 120_000)

  it('returns file contents byte-for-byte', async () => {
    const { readPath } = getLocalWorktreePathAccess({ wslDistro: DISTRO })

    expect(await readPath(unc(`${fixtureRoot}/file.txt`))).toBe(FILE_CONTENTS)
  }, 60_000)

  it('is unaffected by what a login shell would have printed', async () => {
    const { readPath } = getLocalWorktreePathAccess({ wslDistro: DISTRO })
    const raw = await readThroughRawLoginShell(`${fixtureRoot}/file.txt`)

    // Contrast: routed through a login shell the read carries whatever the rc
    // files printed (stock Ubuntu ships a sudo hint). These reads use a plain
    // `sh -c`, which runs no rc at all, so they are exactly the file.
    expect(raw.endsWith(FILE_CONTENTS)).toBe(true)
    expect(await readPath(unc(`${fixtureRoot}/file.txt`))).toBe(FILE_CONTENTS)
  }, 60_000)

  it.each([
    ['dir', 'directory'],
    ['file.txt', 'file']
  ])(
    'stats %s as a usable type, not shell chatter',
    async (entry, expectedType) => {
      const { statPath } = getLocalWorktreePathAccess({ wslDistro: DISTRO })

      const stat = (await statPath(unc(`${fixtureRoot}/${entry}`))) as { type: string }

      expect(stat.type).toBe(expectedType)
    },
    60_000
  )

  it('still reports a missing path as ENOENT', async () => {
    const { statPath } = getLocalWorktreePathAccess({ wslDistro: DISTRO })

    await expect(statPath(unc(`${fixtureRoot}/absent`))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})
