// Real sh/dash/ash under a pty: an interactive shell reads $ENV only with a terminal attached.
// Locally this covers /bin/sh and whichever of dash and busybox are installed. The PR body records a
// docker run against dash 0.5.8, 0.5.10, 0.5.11 and 0.5.12, busybox ash and bash-as-sh.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWslInteractiveLoginShellCommand } from '../shared/wsl-login-shell-command'
import { SH_WSL_ENV_FILE } from './wsl-shell-cwd-report'
import { parseFileUriPath } from './daemon/osc7-file-uri'

function findOnPath(name: string): string | null {
  for (const dir of ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

const DASH = findOnPath('dash')
const BUSYBOX = findOnPath('busybox')
// The user's prompt carries `$`, a quote and a backslash, which the prefix must leave intact.
const USER_PS1 = '$PWD "x" \\$ '
const PROMPT_MARK = '"x" '

// Read as the daemon reads a WSL pane's report.
function reports(output: string): (string | null)[] {
  return output
    .split('\x1b]7;')
    .slice(1)
    .map((report) => report.slice(0, report.indexOf('\x07')))
    .map((uri) => parseFileUriPath(uri, { wslDistro: 'Ubuntu' }))
}

function inDistro(posixPath: string): string {
  return `\\\\wsl.localhost\\Ubuntu${posixPath.replace(/\//g, '\\')}`
}

describe.skipIf(process.platform === 'win32')('a WSL bridge sh pane reports its folder', () => {
  let home: string
  let root: string
  let deep: string
  let bin: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-sh-cwd-')))
    // The host-published wrapper root sits under the Windows user's profile, which may have spaces.
    root = path.join(home, 'App Data', 'shell-ready')
    deep = path.join(home, 'deep er', 'déjà a%b#c?d')
    bin = path.join(home, 'bin')
    mkdirSync(path.join(root, 'sh'), { recursive: true })
    mkdirSync(deep, { recursive: true })
    mkdirSync(bin)
    writeFileSync(path.join(root, 'sh', 'env'), SH_WSL_ENV_FILE)
    writeFileSync(path.join(home, '.profile'), `PS1='${USER_PS1}'\n`)
    // The user's ENV names a file whose path has a quote and a space, through a `$` expansion.
    mkdirSync(path.join(home, 'u "q" sp'))
    writeFileSync(path.join(home, 'u "q" sp', 'env'), 'echo USER_ENV_SOURCED\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function bridgeTo(shell: string): Record<string, string> {
    writeFileSync(
      path.join(bin, 'getent'),
      `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::${home}:${shell}"\n`
    )
    chmodSync(path.join(bin, 'getent'), 0o755)
    return { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCA_SHELL_READY_ROOT: root }
  }

  async function runBridge(shell: string, env: Record<string, string>): Promise<string> {
    const nodePty = await import('node-pty')
    const term = nodePty.spawn('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
      name: 'xterm-256color',
      cols: 200,
      rows: 30,
      cwd: home,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...bridgeTo(shell), ...env }
    })
    let rendered = ''
    let exited = false
    term.onExit(() => {
      exited = true
    })
    term.onData((chunk) => {
      rendered += chunk
    })
    const prompts = (): number => rendered.split(PROMPT_MARK).length - 1
    const command = async (line: string): Promise<void> => {
      const before = prompts()
      term.write(`${line}\r`)
      await vi.waitFor(() => expect(prompts()).toBeGreaterThan(before), { timeout: 10_000 })
    }
    await vi.waitFor(() => expect(prompts()).toBe(1), { timeout: 15_000 })
    await command(`cd '${deep}'`)
    await command('echo "CHILD_ENV=[${ENV-unset}]"')
    term.write('exit\r')
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000 })
    return rendered
  }

  // Only the shells this machine has; CI's ubuntu-24.04 has dash as /bin/sh.
  const shells: [string, () => string][] = [['/bin/sh', () => '/bin/sh']]
  if (DASH) {
    shells.push(['dash', () => DASH])
  }
  if (BUSYBOX) {
    shells.push([
      'busybox ash',
      () => {
        const ash = path.join(bin, 'ash')
        symlinkSync(BUSYBOX, ash)
        return ash
      }
    ])
  }

  it.each(shells)(
    '%s: at every prompt inside WSL, after the profile, handing ENV back to the user',
    async (_name, resolve) => {
      const shell = resolve()
      const userEnv = '$HOME/u "q" sp/env'
      const output = await runBridge(shell, { WSL_DISTRO_NAME: 'Ubuntu', ENV: userEnv })
      expect(reports(output)).toEqual([inDistro(home), inDistro(deep), inDistro(deep)])
      expect(output).toContain('USER_ENV_SOURCED')
      expect(output).not.toMatch(/[Ss]yntax error|unexpected|unterminated/u)
      expect(output).toContain(`CHILD_ENV=[${userEnv}]`)
      // The user's prompt survives after the prefix, and no width marker is printed literally.
      expect(output).toContain(`${deep} "x" `)
      expect(output).not.toContain('\\[')
    },
    60_000
  )

  it.each(shells)(
    '%s: leaves ENV unset for children when the user had none, and is silent outside WSL',
    async (_name, resolve) => {
      const output = await runBridge(resolve(), {})
      expect(reports(output)).toEqual([])
      expect(output).toContain('CHILD_ENV=[unset]')
    },
    60_000
  )
})

describe.skipIf(process.platform === 'win32')('the WSL bridge sh ENV file', () => {
  let home: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-sh-env-')))
    writeFileSync(path.join(home, 'env'), SH_WSL_ENV_FILE)
    writeFileSync(path.join(home, 'user-env'), 'echo USER_ENV_SOURCED\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('is never read by a non-interactive sh -c', () => {
    const out = execFileSync(
      '/bin/sh',
      ['-c', 'command -v __orca_wsl_cwd_report >/dev/null && echo HOOKED || echo PLAIN'],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          ENV: path.join(home, 'env'),
          ORCA_WSL_USER_ENV: path.join(home, 'user-env'),
          WSL_DISTRO_NAME: 'Ubuntu'
        }
      }
    )
    expect(out).toBe('PLAIN\n')
  })

  it.each(DASH ? ['/bin/sh', DASH] : ['/bin/sh'])(
    '%s starts quietly when the file is gone (Orca updated away or uninstalled)',
    (shell) => {
      const out = execFileSync(shell, ['-i'], {
        encoding: 'utf8',
        input: 'echo ALIVE\nexit\n',
        env: { PATH: '/usr/bin:/bin', ENV: path.join(home, 'gone', 'env'), PS1: '' }
      })
      expect(out).toContain('ALIVE')
    }
  )
})

describe.skipIf(process.platform === 'win32')('the WSL bridge launch for sh', () => {
  // A stub shell named dash that reports the ENV it was given instead of starting.
  function envGiven(root: string, inherited: Record<string, string> = {}): string {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-sh-launch-')))
    try {
      const stub = path.join(home, 'dash')
      writeFileSync(
        stub,
        '#!/bin/sh\nprintf "ENV=[%s] USER=[%s]\\n" "${ENV-unset}" "${ORCA_WSL_USER_ENV-unset}"\n'
      )
      chmodSync(stub, 0o755)
      writeFileSync(path.join(home, 'getent'), `#!/bin/sh\nprintf '%s\\n' "u:x:1:1::/:${stub}"\n`)
      chmodSync(path.join(home, 'getent'), 0o755)
      mkdirSync(path.join(root, 'sh'), { recursive: true })
      writeFileSync(path.join(root, 'sh', 'env'), SH_WSL_ENV_FILE)
      return execFileSync('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
        encoding: 'utf8',
        env: { PATH: `${home}:/usr/bin:/bin`, ORCA_SHELL_READY_ROOT: root, ...inherited }
      }).trim()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('points ENV at the published file and saves the user value', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-sh-root-')))
    try {
      expect(envGiven(root, { ENV: '$HOME/.shrc' })).toBe(`ENV=[${root}/sh/env] USER=[$HOME/.shrc]`)
      expect(envGiven(root)).toBe(`ENV=[${root}/sh/env] USER=[unset]`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves ENV alone when the root would be mangled by ENV expansion', () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-sh-root-')))
    try {
      expect(envGiven(path.join(base, 'a$b'), { ENV: '/u/env' })).toBe('ENV=[/u/env] USER=[unset]')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
