import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { TerminalViewRgb } from '../../shared/terminal-view-attributes'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import { getShellLaunchConfig } from './local-pty-shell-ready'
import { setTestUserDataPath } from './local-pty-shell-ready-test-harness'

const SHELLS = ['bash', 'zsh', 'fish'].filter(
  (shell) => process.platform !== 'win32' && spawnSync(shell, ['--version']).status === 0
)
const STARTUP_COMMAND = `bash -c 'read -r line; printf "__STARTUP_INPUT__:%s\\n" "$line"'`
const BLACK: TerminalViewRgb = [0, 0, 0]

function afterCommand(shell: string): string {
  if (shell === 'fish') {
    return `if set -q ${POSIX_SHELL_STARTUP_COMMAND_ENV}; echo __AFTER_ENV__:present; else; echo __AFTER_ENV__:missing; end; exit\n`
  }
  return `printf '__AFTER_ENV__:%s\\n' "\${${POSIX_SHELL_STARTUP_COMMAND_ENV}-missing}"; exit\n`
}

describe('local POSIX shell startup-command delivery', () => {
  let testHome: string | undefined

  afterEach(() => {
    if (testHome) {
      rmSync(testHome, { recursive: true, force: true })
      testHome = undefined
    }
  })

  it.each(SHELLS)(
    '%s runs the command once, forwards stdin, and keeps the shell',
    async (shell) => {
      testHome = mkdtempSync(join(tmpdir(), `orca-${shell}-startup-command-`))
      setTestUserDataPath(testHome)
      const launch = getShellLaunchConfig(
        shell,
        ['overlay', 'markers', 'ready', 'identity'],
        STARTUP_COMMAND
      )
      expect(launch.env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(STARTUP_COMMAND)

      const output = await new Promise<string>((resolve, reject) => {
        let proc!: pty.IPty
        const emulator = new HeadlessEmulator({
          cols: 120,
          rows: 30,
          onQueryReply: (reply) => {
            if (!ingress.answerLiveQueryReply(reply)) {
              proc.write(reply)
            }
          }
        })
        emulator.installViewAttributeResponder(() => ({
          foreground: [255, 255, 255],
          background: BLACK,
          cursor: [255, 255, 255],
          ansi: Array.from({ length: 256 }, () => BLACK),
          colorSchemeMode: 'dark',
          cursorStyle: 'block',
          cursorBlink: false
        }))
        proc = pty.spawn(shell, launch.args ?? [], {
          cols: 120,
          rows: 30,
          cwd: testHome,
          env: {
            ...process.env,
            ...launch.env,
            HOME: testHome,
            ORCA_ORIG_ZDOTDIR: testHome,
            ORCA_ZSHENV_SOURCE_DIR: testHome,
            TERM: 'xterm-256color'
          }
        })
        let transcript = ''
        let sentInput = false
        let sentAfter = false
        const ingress = new PtyStartupIngress({
          ownerBackend: 'posix-pty',
          write: (data) => proc.write(data),
          onEmission: (emission) => {
            transcript += emission.data
            void emulator.write(emission.data, { forwardQueryReplies: true })
            if (!sentInput && transcript.includes(STARTUP_COMMAND)) {
              sentInput = true
              proc.write('hello\n')
            }
            if (!sentAfter && transcript.includes('__STARTUP_INPUT__:hello')) {
              sentAfter = true
              proc.write(afterCommand(shell))
            }
          }
        })
        const timeout = setTimeout(() => {
          proc.kill()
          emulator.dispose()
          reject(new Error(`${shell} startup command timed out: ${JSON.stringify(transcript)}`))
        }, 5_000)

        proc.onData((data) => ingress.accept(data))
        proc.onExit(() => {
          clearTimeout(timeout)
          ingress.drainAndClose()
          emulator.dispose()
          resolve(transcript)
        })
      })

      expect(output.split(STARTUP_COMMAND)).toHaveLength(2)
      expect(output).toContain('__STARTUP_INPUT__:hello')
      expect(output).toContain('__AFTER_ENV__:missing')
    }
  )
})
