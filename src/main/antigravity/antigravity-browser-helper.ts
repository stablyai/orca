// The Antigravity server opens its Google sign-in page through BROWSER. Orca points that at a
// one-line program run by its own executable in Node mode, which prints the link on error output
// instead: the link is captured either way, and no browser opens on the host.

import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'
import { runProcess } from '@orca/process-host'

export const ANTIGRAVITY_BROWSER_MARKER = '__ORCA_ANTIGRAVITY_AUTH_URL__'

// EPIPE still exits 0, or Python falls back to a real browser once nothing reads the output.
const HELPER_SOURCE =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`
const PREFLIGHT_URL = 'https://example.invalid/orca-antigravity-browser-preflight'

// Python splits BROWSER with shlex.

// Node mode is set in the command itself: the provider supervisor strips ELECTRON_RUN_AS_NODE from
// the server, which keeps it out of the agent's own tools.
const executable = process.execPath.replaceAll('\\', '\\\\').replaceAll(':', '\\072')
const shell = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$(printf %b ${quotePosixShellDoubleQuotedApostrophe(executable)})" -e ${quotePosixShellDoubleQuotedApostrophe(HELPER_SOURCE)} -- "$1"`
const BROWSER_ARGV = ['/bin/sh', '-c', shell, '--', '%s']
export const ANTIGRAVITY_BROWSER_COMMAND = BROWSER_ARGV.map(
  quotePosixShellDoubleQuotedApostrophe
).join(' ')
const usable = !/[\r\n\0]|%s/.test(process.execPath)

/** The exact template the server's Python browser controller executes. */
export const antigravityBrowserArgv = (link: string): string[] =>
  BROWSER_ARGV.map((arg) => (arg === '%s' ? link : arg))

/** Runs the helper once as the server would; checked before every server start, since a broken
 *  helper would let the server open a browser on this host. */
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
