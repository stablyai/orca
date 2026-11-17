import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslGuestShellPaths } from './wsl-guest-drive-path'

// Runs the emitted shell with a stand-in `wslpath` that mounts C: under a custom root, as WSL does.
describe.skipIf(process.platform === 'win32')('wslGuestShellPaths', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-guest-drive-')))
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'qamnt', 'c', 'src', "it's app"), { recursive: true })
    const wslpath = join(root, 'bin', 'wslpath')
    writeFileSync(
      wslpath,
      `#!/bin/sh\n[ "$1" = -u ] && [ "$2" = 'C:\\' ] && echo '${root}/qamnt/c/' && exit 0\nexit 1\n`
    )
    chmodSync(wslpath, 0o755)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function run(script: string) {
    return spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }
    })
  }

  it('enters a drive path under the mount root the distro reports', () => {
    const { prelude, words } = wslGuestShellPaths(["C:\\src\\it's app", '/plain'], 128)
    const result = run(`${prelude}cd ${words[0]} && pwd && echo ${words[1]}`)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${root}/qamnt/c/src/it's app\n/plain\n`)
  })

  it('stops before the command when the drive has no mount', () => {
    const { prelude, words } = wslGuestShellPaths(['D:\\src'], 128)
    const result = run(`${prelude}echo ran ${words[0]}`)
    expect(result.status).toBe(128)
    expect(result.stdout).toBe('')
  })
})
