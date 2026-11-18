import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const RESOURCES = resolve(__dirname, '../../../resources')
const root = mkdtempSync(join(tmpdir(), 'cli-launcher-handoff-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// Each launcher in an app layout whose Electron just names itself, so a run says which CLI answered.
const LAUNCHERS = {
  darwin: (() => {
    const app = join(root, 'Orca.app', 'Contents')
    mkdirSync(join(app, 'MacOS'), { recursive: true })
    mkdirSync(join(app, 'Resources', 'bin'), { recursive: true })
    executable(join(app, 'MacOS', 'Orca'), 'shift; echo "installed $*"')
    const launcher = join(app, 'Resources', 'bin', 'orca')
    copyFileSync(join(RESOURCES, 'darwin', 'bin', 'orca'), launcher)
    chmodSync(launcher, 0o755)
    return launcher
  })(),
  linux: (() => {
    const app = join(root, 'linux-app')
    mkdirSync(join(app, 'resources', 'bin'), { recursive: true })
    executable(join(app, 'orca-ide'), 'shift; echo "installed $*"')
    const launcher = join(app, 'resources', 'bin', 'orca-ide')
    copyFileSync(join(RESOURCES, 'linux', 'bin', 'orca-ide'), launcher)
    chmodSync(launcher, 0o755)
    return launcher
  })()
}

const SESSION_CLI = executable(
  join(root, 'session-orca'),
  'echo "session $* handoff=${ORCA_CLI_HANDOFF:-}"'
)

function run(launcher: string, env: Record<string, string>): string {
  return execFileSync(launcher, ['connector', 'reply', '--text', 'hi there'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8'
  }).trim()
}

describe.skipIf(process.platform === 'win32').each(Object.entries(LAUNCHERS))(
  'the %s CLI launcher',
  (_platform, launcher) => {
    it("hands off to the session's own CLI, arguments intact", () => {
      expect(run(launcher, { ORCA_CLI_COMMAND: SESSION_CLI })).toBe(
        `session connector reply --text hi there handoff=${SESSION_CLI}`
      )
    })

    it('runs itself when the session names this launcher, directly or through a link', () => {
      const link = join(root, `link-to-${_platform}`)
      symlinkSync(launcher, link)
      expect(run(launcher, { ORCA_CLI_COMMAND: launcher })).toBe(
        'installed connector reply --text hi there'
      )
      expect(run(link, { ORCA_CLI_COMMAND: link })).toBe(
        'installed connector reply --text hi there'
      )
    })

    it('runs itself when the named CLI is gone, relative, or not runnable', () => {
      const notRunnable = join(root, `plain-file-${_platform}`)
      writeFileSync(notRunnable, 'echo nope\n')
      for (const named of [join(root, 'missing-orca'), 'session-orca', notRunnable]) {
        expect(run(launcher, { ORCA_CLI_COMMAND: named })).toBe(
          'installed connector reply --text hi there'
        )
      }
    })

    it('runs itself, unchanged, outside a session', () => {
      expect(run(launcher, {})).toBe('installed connector reply --text hi there')
    })

    it('never hands back once the named CLI was reached through a hand-off', () => {
      expect(run(launcher, { ORCA_CLI_COMMAND: SESSION_CLI, ORCA_CLI_HANDOFF: SESSION_CLI })).toBe(
        'installed connector reply --text hi there'
      )
    })
  }
)
