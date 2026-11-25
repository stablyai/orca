import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../../pty/shell-startup/posix-shell-startup-command'
import { SHELL_STARTUP_FEATURE_ENV } from '../../pty/shell-startup/shell-startup-features'
import { hasZsh, ZSH_PATH } from '../../pty/shell-startup/zsh-startup-hook-pty-harness'
import { getShellLaunchConfig } from './shell-ready'

let scratch: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-daemon-zsh-startup-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = join(scratch, 'user-data')
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(scratch, { recursive: true, force: true })
})

describe('daemon zsh startup command delivery', () => {
  it('hands a startup command to the wrapper instead of typing it', () => {
    const config = getShellLaunchConfig('/bin/zsh', ['ready', 'markers'], {
      hasStartupCommand: true,
      startupCommand: "claude 'hello'",
      inheritedXdgDataDirs: undefined
    })

    expect(config.startupCommandDeliveredByWrapper).toBe(true)
    expect(config.env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe("claude 'hello'")
    expect(config.env[SHELL_STARTUP_FEATURE_ENV]).toBe('ready,markers,startup')
  })

  it('leaves panes without a startup command untouched', () => {
    const config = getShellLaunchConfig('/bin/zsh', ['ready'], {
      inheritedXdgDataDirs: undefined
    })

    expect(config.startupCommandDeliveredByWrapper).toBeUndefined()
    expect(config.env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBeUndefined()
    expect(config.env[SHELL_STARTUP_FEATURE_ENV]).toBe('ready')
  })

  // oh-my-zsh's update question reads one key from the TTY during .zshrc; a typed launch line lost its first byte to it.
  it.skipIf(!hasZsh)(
    'runs the whole command after a .zshrc that reads the TTY',
    async () => {
      const home = join(scratch, 'home')
      const outPath = join(scratch, 'ran.txt')
      const answerPath = join(scratch, 'answer.txt')
      rmSync(home, { recursive: true, force: true })
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(home, '.zshrc'),
        `printf 'Would you like to update? [Y/n] '\nread -r -t 2 -k 1 option\nprint -r -- "<$option>" > ${JSON.stringify(answerPath)}\n`
      )
      const command = `print -r -- launched-in-full > ${JSON.stringify(outPath)}`
      const config = getShellLaunchConfig(ZSH_PATH, ['ready', 'markers'], {
        hasStartupCommand: true,
        startupCommand: command,
        inheritedXdgDataDirs: undefined
      })
      const proc = pty.spawn(ZSH_PATH, config.args ?? ['-l'], {
        cols: 120,
        rows: 30,
        cwd: home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          TERM: 'xterm-256color',
          ...config.env
        }
      })
      try {
        const deadline = Date.now() + 15_000
        while (!existsSync(outPath) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      } finally {
        proc.kill()
      }

      expect(readFileSync(outPath, 'utf8').trim()).toBe('launched-in-full')
      // Nothing was typed, so the rc file's question saw no key.
      expect(readFileSync(answerPath, 'utf8').trim()).toBe('<>')
    },
    20_000
  )
})
