// Where wsl.exe drops redirected list output (#35509) it still writes to a console, so ask through one.
import { createRequire } from 'node:module'
import type * as pty from 'node-pty'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { stripAnsiEscapeSequences } from '../shared/ansi-escape-sequences'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'

const requireFromMain = createRequire(__filename)
const MAX_OUTPUT_CHARS = 64 * 1024
// ConPTY may place rows by cursor moves rather than line feeds.
// oxlint-disable-next-line no-control-regex -- matches the ESC that introduces a cursor move.
const CURSOR_POSITION = /\u001b\[\d*(?:;\d*)?[Hf]/g

export type WslConsole = Pick<pty.IPty, 'onData' | 'onExit' | 'kill'>
export type SpawnWslConsole = (args: string[]) => WslConsole

const spawnWslConsole: SpawnWslConsole = (args) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-pty's installed package implements the declared spawn contract.
  const nodePty = requireFromMain('node-pty') as typeof pty
  return nodePty.spawn(windowsSystem32Binary('wsl.exe'), args, {
    name: 'xterm',
    cols: 512,
    rows: 50,
    cwd: resolveWslInteropSpawnCwd(),
    env: process.env
  })
}

// Non-quiet output: a localized header, then one name per row; the default carries a localized suffix.
// Some locales omit the space (ko-KR), use a no-break space (nb-NO), or full-width parens.
const DISTRO_ROW = /^\s*\*?\s*([^\s(\uff08]+)\s*(?:[(\uff08].*[)\uff09])?\s*$/

function consoleText(output: string): string {
  return stripAnsiEscapeSequences(output.replace(CURSOR_POSITION, '\n'))
}

/** Registered names among the console's rows; anything else the console painted is ignored. */
export function parseConsoleWslDistros(output: string, registered: readonly string[]): string[] {
  const byKey = new Map(registered.map((distro) => [distro.toLowerCase(), distro]))
  const found = new Set<string>()
  for (const line of consoleText(output).split(/\r?\n|\r/)) {
    const distro = byKey.get(DISTRO_ROW.exec(line)?.[1]?.toLowerCase() ?? '')
    if (distro) {
      found.add(distro)
    }
  }
  return [...found]
}

/**
 * Only a painted registered name counts. A blank console may itself have lost the output, and the
 * "none running" text is localized, so on these hosts "nothing runs" stays unverifiable (#35509).
 */
export function consoleRunningVerdict(
  output: string,
  exitCode: number,
  registered: readonly string[]
): string[] | Error {
  const running = parseConsoleWslDistros(output, registered)
  if (exitCode === 0 && running.length > 0) {
    return running
  }
  return new Error(`wsl.exe console list was not recognisable (exit ${exitCode})`)
}

/** Running distros among `registered`. A list call never starts a distro; throws when the console can't answer. */
export function listRunningWslDistrosViaConsole(
  registered: readonly string[],
  timeoutMs: number,
  spawn: SpawnWslConsole = spawnWslConsole
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let proc: WslConsole
    try {
      proc = spawn(['--list', '--running'])
    } catch (error) {
      reject(error)
      return
    }
    let output = ''
    let settled = false
    const subscriptions: pty.IDisposable[] = []
    const finish = (verdict: string[] | Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      subscriptions.forEach((subscription) => subscription.dispose())
      if (verdict instanceof Error) {
        try {
          proc.kill()
        } catch {
          // Already exited.
        }
        reject(verdict)
        return
      }
      resolve(verdict)
    }
    const timer = setTimeout(() => finish(new Error('wsl.exe console list timed out')), timeoutMs)
    subscriptions.push(
      proc.onData((data) => {
        output += data
        if (output.length > MAX_OUTPUT_CHARS) {
          finish(new Error('wsl.exe console list output exceeded its limit'))
        }
      }),
      // node-pty reports exit only after the console's output has drained.
      proc.onExit(({ exitCode }) => finish(consoleRunningVerdict(output, exitCode, registered)))
    )
  })
}
