// Capture sign-in URLs on stderr so remote hosts never open a browser.

import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'
import { runProcess } from '@orca/process-host'

export const ANTIGRAVITY_BROWSER_MARKER = '__ORCA_ANTIGRAVITY_AUTH_URL__'

// EPIPE still exits 0, or Python falls back to a real browser once nothing reads the output.
const HELPER_SOURCE =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`
const PREFLIGHT_URL = 'https://example.invalid/orca-antigravity-browser-preflight'

// Escape colons for Python’s BROWSER list before shlex parses the command.

// The supervisor strips Node mode from the server, so set it only for this helper.
const executable = process.execPath.replaceAll('\\', '\\\\').replaceAll(':', '\\072')
const shell = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$(printf %b ${quotePosixShellDoubleQuotedApostrophe(executable)})" -e ${quotePosixShellDoubleQuotedApostrophe(HELPER_SOURCE)} -- "$1"`
const BROWSER_ARGV = ['/bin/sh', '-c', shell, '--', '%s']
export const ANTIGRAVITY_BROWSER_COMMAND = BROWSER_ARGV.map(
  quotePosixShellDoubleQuotedApostrophe
).join(' ')
const usable = !/[\r\n\0]|%s/.test(process.execPath)

export const antigravityBrowserArgv = (link: string): string[] =>
  BROWSER_ARGV.map((arg) => (arg === '%s' ? link : arg))

/** Check before each server start: a broken helper could let Python launch a real browser. */
export async function antigravityBrowserHelperWorks(): Promise<boolean> {
  if (!usable) {
    return false
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
