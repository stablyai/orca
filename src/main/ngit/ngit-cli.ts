import { runProcess } from '@orca/process-host'
import { resolveCliCommandAsync } from '../../shared/shell/command-resolution/node-cli-command-async-resolution'

const NGIT_TIMEOUT_MS = 180_000
const NGIT_MAX_BUFFER = 8 * 1024 * 1024
const MAX_ERROR_CHARS = 600

export class NgitCliMissingError extends Error {
  constructor() {
    super('The ngit CLI is not installed on this host. Install it, then run `ngit account login`.')
    this.name = 'NgitCliMissingError'
  }
}

export type NgitExec = (args: string[], cwd: string) => Promise<string>

/** ngit explains failures as a JSON object on stdout; a secret never travels through its argv. */
export function ngitErrorMessage(stdout: string, stderr: string, fallback: string): string {
  const reported = stdout.match(/"error"\s*:\s*("(?:[^"\\]|\\.)*")/)?.[1]
  const message = reported ? String(JSON.parse(reported)) : stderr.trim() || fallback
  return message
    .replace(/nsec1[0-9a-z]+|nbunksec1[0-9a-z]+/gi, '[redacted]')
    .slice(-MAX_ERROR_CHARS)
}

/** Runs `ngit` the way Orca runs `gh`: the CLI owns the signing identity and publishes. */
export const execNgit: NgitExec = async (args, cwd) => {
  const result = await runProcess({
    program: await resolveCliCommandAsync('ngit'),
    args,
    cwd,
    timeoutMs: NGIT_TIMEOUT_MS,
    maxOutputBytes: NGIT_MAX_BUFFER
  }).catch((error: unknown) => {
    const failure: { code?: unknown } = Object(error)
    throw failure.code === 'ENOENT' ? new NgitCliMissingError() : error
  })
  if (result.code === 0 && !result.timedOut && !result.outputTruncated) {
    return result.stdout
  }
  throw new Error(
    ngitErrorMessage(
      result.stdout,
      result.stderr,
      result.timedOut ? 'ngit timed out.' : `ngit exited with ${result.code}.`
    )
  )
}
