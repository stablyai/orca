import { spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { TerminalViewRgb } from '../../shared/terminal-view-attributes'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import { setAppEnvironment } from '../../shared/app-environment'
import { getShellLaunchConfig } from './local-pty-shell-ready'

const STARTUP_COMMAND = `bash -c 'read -r line; printf "__STARTUP_INPUT__:%s\\n" "$line"'`
const BLACK: TerminalViewRgb = [0, 0, 0]

function afterCommand(shell: string): string {
  if (shell === 'fish') {
    return `if set -q ${POSIX_SHELL_STARTUP_COMMAND_ENV}; echo __AFTER_ENV__:present; else; echo __AFTER_ENV__:missing; end; exit\n`
  }
  return `printf '__AFTER_ENV__:%s\\n' "\${${POSIX_SHELL_STARTUP_COMMAND_ENV}-missing}"; exit\n`
}

export async function runShellStartupCommandFixture({
  shell,
  home
}: {
  shell: string
  home: string
}): Promise<string> {
  setAppEnvironment({
    getPath: () => home,
    getAppPath: () => home,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit() {},
    exit: (code) => process.exit(code),
    getAppMetrics: () => []
  })
  const launch = getShellLaunchConfig(
    shell,
    ['overlay', 'markers', 'ready', 'identity'],
    STARTUP_COMMAND
  )
  if (launch.env[POSIX_SHELL_STARTUP_COMMAND_ENV] !== STARTUP_COMMAND) {
    throw new Error('Startup command was not embedded')
  }
  return await new Promise<string>((resolve, reject) => {
    let proc!: ReturnType<typeof spawnBunPty>
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
    proc = spawnBunPty({
      file: shell,
      args: launch.args ?? [],
      cols: 120,
      rows: 30,
      cwd: home,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        ),
        ...launch.env,
        HOME: home,
        ORCA_ORIG_ZDOTDIR: home,
        ORCA_ZSHENV_SOURCE_DIR: home,
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
      proc.destroy()
      resolve(transcript)
    })
  })
}
