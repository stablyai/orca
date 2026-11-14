// Capture sign-in URLs on stderr so remote hosts never open a browser.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell/launch/shell-argument-quoting'
import { runProcess } from '@orca/process-host'

export const ANTIGRAVITY_BROWSER_MARKER = '__ORCA_ANTIGRAVITY_AUTH_URL__'

// EPIPE still exits 0, or Python falls back to a real browser once nothing reads the output.
const HELPER_SOURCE =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`
const PREFLIGHT_URL = 'https://example.invalid/orca-antigravity-browser-preflight'

const WINDOWS_HELPER_SOURCE = `try { var u = WScript.Arguments.length > 0 ? WScript.Arguments(0) : ""; WScript.StdErr.Write("${ANTIGRAVITY_BROWSER_MARKER}" + (typeof JSON !== "undefined" ? JSON.stringify(u) : ("\\"" + u.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\"") + "\\"")) + "\\n"); } catch(e) {} WScript.Quit(0);\n`
const WINDOWS_HELPER_PATH = join(tmpdir(), 'orca-antigravity-browser-helper.js')

// Escape colons for Python’s BROWSER list before shlex parses the command.

// The supervisor strips Node mode from the server, so set it only for this helper.
const executable = process.execPath.replaceAll('\\', '\\\\').replaceAll(':', '\\072')
const shell = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$(printf %b ${quotePosixShellDoubleQuotedApostrophe(executable)})" -e ${quotePosixShellDoubleQuotedApostrophe(HELPER_SOURCE)} -- "$1"`
const BROWSER_ARGV =
  process.platform === 'win32'
    ? ['cscript.exe', '//nologo', WINDOWS_HELPER_PATH, '%s']
    : ['/bin/sh', '-c', shell, '--', '%s']

export const ANTIGRAVITY_BROWSER_COMMAND =
  process.platform === 'win32'
    ? BROWSER_ARGV.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')
    : BROWSER_ARGV.map(quotePosixShellDoubleQuotedApostrophe).join(' ')

const usable = process.platform === 'win32' ? true : !/[\r\n\0]|%s/.test(process.execPath)

export const antigravityBrowserArgv = (link: string): string[] =>
  BROWSER_ARGV.map((arg) => (arg === '%s' ? link : arg))

/** Check before each server start: a broken helper could let Python launch a real browser. */
export async function antigravityBrowserHelperWorks(): Promise<boolean> {
  if (!usable) {
    return false
  }
  if (process.platform === 'win32') {
    await writeFile(WINDOWS_HELPER_PATH, WINDOWS_HELPER_SOURCE, 'utf8').catch(() => {})
  }
  const [program = '', ...args] = antigravityBrowserArgv(PREFLIGHT_URL)
  const spec = { program, args, timeoutMs: 5_000, maxOutputBytes: 4_096 }
  const result = await runProcess(spec).catch(() => null)
  return (
    result?.code === 0 &&
    result.stdout === '' &&
    result.stderr === `${ANTIGRAVITY_BROWSER_MARKER}${JSON.stringify(PREFLIGHT_URL)}\n`
  )
}
