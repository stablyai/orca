import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseOpenCodeCliVersion } from '../../shared/opencode-cli-version'
import { guestLoginShellLaunch } from './opencode-wsl-guest-launch'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A login profile that defines the command only as an unexported function and sets its own values. */
function guestHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-opencode-login-')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  for (const directory of [home, bin, repo]) {
    mkdirSync(directory)
  }
  writeFileSync(
    join(home, '.profile'),
    [
      'echo Profile startup banner',
      'export OPENCODE_CONFIG=rc OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=rc OPENCODE_PASSWORD=rc OPENCODE_DISABLE_SHARE=0',
      `orca_fixture_opencode() { if [ "$1" = --version ]; then printf '1.18.31\\n'; else printf 'function:%s cwd:%s config:%s password:%s username:%s v2:%s share:%s\\n' "$*" "$(pwd)" "$OPENCODE_CONFIG" "$OPENCODE_SERVER_PASSWORD" "$OPENCODE_SERVER_USERNAME" "$OPENCODE_PASSWORD" "$OPENCODE_DISABLE_SHARE"; fi; }`
    ].join('\n')
  )
  writeFileSync(join(home, '.zprofile'), "emulate sh -c '. ~/.profile'\n")
  // `/usr/bin/env` cannot call a function; the old route then reached PATH, as this one must.
  // A fixture-only name keeps a real installed OpenCode from ever running here.
  const executable = join(bin, 'orca_fixture_opencode')
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf 'path:%s config:%s password:%s\\n' "$*" "$OPENCODE_CONFIG" "$OPENCODE_SERVER_PASSWORD"\n`
  )
  chmodSync(executable, 0o755)
  return {
    repo,
    env: {
      HOME: home,
      SHELL: '/bin/sh',
      PATH: `${bin}:/usr/bin:/bin`,
      OPENCODE_SERVER_USERNAME: 'opencode'
    }
  }
}

function runRaw(launch: ReturnType<typeof guestLoginShellLaunch>): string {
  const result = spawnSync(launch.binary, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    encoding: 'utf8'
  })
  return result.stdout
}

function run(launch: ReturnType<typeof guestLoginShellLaunch>): string {
  return runRaw(launch).trim().split('\n').at(-1) ?? ''
}

describe.skipIf(process.platform === 'win32')('guestLoginShellLaunch', () => {
  it('reaches a profile-defined command, with task-private values winning over the profile', () => {
    const guest = guestHome()
    const launch = guestLoginShellLaunch(
      {
        binary: 'orca_fixture_opencode',
        args: ['serve', '--port', '0'],
        cwd: guest.repo,
        env: { ...guest.env, OPENCODE_SERVER_PASSWORD: 'task-secret-7f3' },
        stdinMode: 'pipe',
        useCwdForNative: true
      },
      guest.env,
      {
        OPENCODE_SERVER_USERNAME: 'custom',
        OPENCODE_PASSWORD: 'inline',
        OPENCODE_DISABLE_SHARE: '0'
      },
      {
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: 'task-secret-7f3',
        OPENCODE_PASSWORD: 'task-v2-secret',
        OPENCODE_DISABLE_SHARE: '1'
      }
    )

    expect(launch.args.join(' ')).not.toContain('task-secret-7f3')
    expect(run(launch)).toBe(
      `function:serve --port 0 cwd:${guest.repo} config:rc password:task-secret-7f3 username:opencode v2:task-v2-secret share:1`
    )
  })

  it('applies inline command assignments after the profile, as the CLI route did', () => {
    const guest = guestHome()
    const launch = guestLoginShellLaunch(
      {
        binary: 'orca_fixture_opencode',
        args: ['--version'],
        cwd: guest.repo,
        env: guest.env,
        stdinMode: 'pipe',
        useCwdForNative: true
      },
      guest.env,
      { OPENCODE_CONFIG: '/home/dev/work.json' }
    )

    expect(run(launch)).toBe('path:--version config:/home/dev/work.json password:rc')
  })
})

it.skipIf(process.platform === 'win32')(
  'captures only the selected version command after login banners',
  () => {
    const guest = guestHome()
    const launch = guestLoginShellLaunch(
      {
        binary: 'orca_fixture_opencode',
        args: ['--version'],
        cwd: guest.repo,
        env: guest.env,
        stdinMode: 'pipe',
        useCwdForNative: true
      },
      guest.env,
      {},
      {},
      true
    )
    const output = runRaw(launch)
    expect(output).toContain('Profile startup banner')
    expect(parseOpenCodeCliVersion(launch.readStdout?.(output))).toBe('1.18.31')
    expect(launch.readStdout?.('Profile startup banner\n1.18.31')).toBeNull()
  }
)
