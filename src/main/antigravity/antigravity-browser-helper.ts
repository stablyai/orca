// Capture sign-in URLs on stderr so remote hosts never open a browser.

import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell/launch/shell-argument-quoting'
import { runProcess } from '@orca/process-host'
import { scrubAntigravityAcpEnvironment } from './antigravity-acp-environment-sanitizer'

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
const WINDOWS_BROWSER_ARGV = [process.execPath, '-e', HELPER_SOURCE, '--', '%s']
const POSIX_BROWSER_COMMAND = BROWSER_ARGV.map(quotePosixShellDoubleQuotedApostrophe).join(' ')
const WINDOWS_BROWSER_COMMAND = WINDOWS_BROWSER_ARGV.map(
  (arg) => `'${arg.replaceAll("'", `'"'"'`)}'`
).join(' ')
const usable =
  !/[\r\n\0]|%s/.test(process.execPath) &&
  (process.platform !== 'win32' || !process.execPath.includes(';'))

export const ANTIGRAVITY_BROWSER_COMMAND =
  process.platform === 'win32' ? WINDOWS_BROWSER_COMMAND : POSIX_BROWSER_COMMAND

export const antigravityBrowserArgv = (link: string): string[] =>
  (process.platform === 'win32' ? WINDOWS_BROWSER_ARGV : BROWSER_ARGV).map((arg) =>
    arg === '%s' ? link : arg
  )

export const antigravityBrowserHelperPreflightPassed = (result: {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly outputTruncated?: boolean
}): boolean =>
  result.code === 0 &&
  result.stdout === '' &&
  !result.outputTruncated &&
  result.stderr === `${ANTIGRAVITY_BROWSER_MARKER}${JSON.stringify(PREFLIGHT_URL)}\n`

/** Check before each server start: a broken helper could let Python launch a real browser. */
export async function antigravityBrowserHelperWorks(): Promise<boolean> {
  if (!usable) {
    return false
  }
  const [program = '', ...args] = antigravityBrowserArgv(PREFLIGHT_URL)
  const env = { ...process.env } as Record<string, string>
  scrubAntigravityAcpEnvironment(env, process.env)
  const spec = {
    program,
    args,
    ...(process.platform === 'win32' ? { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    timeoutMs: 5_000,
    maxOutputBytes: 4_096
  }
  const result = await runProcess(spec).catch(() => null)
  return result !== null && antigravityBrowserHelperPreflightPassed(result)
}
