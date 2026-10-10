/**
 * End-to-end proof that a real Atuin, driven by a real bash-preexec, records
 * every command exactly once under the daemon Bash wrapper.
 *
 * Why opt-in rather than a CI job: it needs a PTY plus two third-party binaries
 * that no default job installs, and fetching them per run would put a network
 * download in front of every unit-test lane. The shell contract it protects —
 * finishing bash-preexec's pending deferred install across its 0.6.0 and 0.7.0+
 * install-string shapes without dropping a user DEBUG trap — runs by default in
 * shell-ready-bash-preexec-deferred-install.test.ts. Run this one against real
 * releases when touching that install:
 *
 *   ORCA_TEST_BASH_PREEXEC=/path/to/bash-preexec.sh \
 *   ORCA_TEST_ATUIN=/path/to/atuin pnpm test src/main/daemon/shell-ready-atuin.node-pty.test.ts
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { IPty } from 'node-pty'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'

const bashPreexec = process.env.ORCA_TEST_BASH_PREEXEC
const bash = process.env.ORCA_TEST_BASH ?? 'bash'
const atuin = process.env.ORCA_TEST_ATUIN ?? 'atuin'

it.skipIf(process.platform === 'win32' || !bashPreexec)(
  'records real Atuin history across three daemon Bash prompt cycles',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-atuin-'))
    const config = join(home, 'atuin')
    mkdirSync(config)
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      ATUIN_SESSION: randomUUID(),
      ATUIN_CONFIG_DIR: config,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      HISTFILE: join(home, 'bash_history'),
      ORCA_SHELL_FEATURES: 'ready',
      TERM: 'xterm-256color',
      ORCA_TEST_BASH_PREEXEC: bashPreexec!,
      ORCA_TEST_ATUIN: atuin
    }
    writeFileSync(
      join(config, 'config.toml'),
      [
        ...Object.entries({
          db_path: 'history.db',
          record_store_path: 'records.db',
          key_path: 'key',
          session_path: 'session'
        }).map(([key, file]) => `${key} = ${JSON.stringify(join(config, file))}`),
        'auto_sync = false',
        'update_check = false',
        ''
      ].join('\n')
    )
    const prompt = 'ORCA_ATUIN_PROMPT> '
    writeFileSync(
      join(home, '.bash_profile'),
      [
        'source "$ORCA_TEST_BASH_PREEXEC"',
        'eval "$("$ORCA_TEST_ATUIN" init bash --disable-up-arrow --disable-ctrl-r)"',
        `PS1='${prompt}'`,
        ''
      ].join('\n')
    )
    const rcfile = join(home, 'rcfile')
    writeFileSync(rcfile, getDaemonBashShellReadyRcfileContent())
    const commands = ['true # atuin-first', 'false # atuin-second', 'true # atuin-third']
    const oscC = '\x1b]133;C\x07'
    const oscD = '\x1b]133;D;'
    let proc: IPty | undefined
    let exited = false
    try {
      // Defer native loading so unconfigured integration runs can skip without a built node-pty.
      const pty = await import('node-pty')
      const version = spawnSync(atuin, ['--version'], { env, encoding: 'utf8', timeout: 5000 })
      expect(version.error).toBeUndefined()
      expect(version.status, version.stderr).toBe(0)
      proc = pty.spawn(bash, ['--noprofile', '--rcfile', rcfile, '-i'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 24,
        cwd: home,
        env
      })
      let output = ''
      proc.onData((chunk) => {
        output += chunk
      })
      const exit = new Promise<number>((resolve) => {
        proc!.onExit(({ exitCode }) => {
          exited = true
          resolve(exitCode)
        })
      })
      await expect.poll(() => output.includes(prompt), { timeout: 10_000 }).toBe(true)
      expect(output).not.toContain(oscC)
      expect(output).not.toContain(oscD)
      for (const [index, command] of commands.entries()) {
        const offset = output.length
        proc.write(`${command}\r`)
        await expect
          .poll(() => output.slice(offset).includes(prompt), { timeout: 10_000 })
          .toBe(true)
        const cycle = output.slice(offset)
        expect.soft(cycle.split(oscC)).toHaveLength(2)
        expect.soft(cycle.split(oscD)).toHaveLength(2)
        expect.soft(cycle).toContain(`${oscD}${index === 1 ? 1 : 0}\x07`)
      }
      // Atuin finishes history writes asynchronously after each prompt.
      await expect
        .poll(
          () => {
            const history = spawnSync(atuin, ['history', 'list', '--format', '{command}'], {
              env,
              encoding: 'utf8',
              timeout: 5000
            })
            expect(history.error).toBeUndefined()
            expect(history.status, history.stderr).toBe(0)
            const recorded = history.stdout.split('\n')
            return commands.map((command) => recorded.filter((line) => line === command).length)
          },
          { timeout: 10_000 }
        )
        .toEqual([1, 1, 1])
      proc.write('exit 0\r')
      await expect.poll(() => exited, { timeout: 5000 }).toBe(true)
      expect(await exit).toBe(0)
    } finally {
      if (proc && !exited) {
        proc.kill()
        await expect.poll(() => exited, { timeout: 5000 }).toBe(true)
      }
      rmSync(home, { recursive: true, force: true })
    }
  }
)
