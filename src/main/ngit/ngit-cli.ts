import { execFileCaptureToTermination } from '../git/command-runner/process-capture/exec-file-capture'
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
  try {
    const { stdout } = await execFileCaptureToTermination(
      await resolveCliCommandAsync('ngit'),
      args,
      { cwd, timeout: NGIT_TIMEOUT_MS, maxBuffer: NGIT_MAX_BUFFER, encoding: 'utf-8' }
    )
    return String(stdout)
  } catch (error) {
    const failure: { code?: unknown; stdout?: unknown; stderr?: unknown } = Object(error)
    if (failure.code === 'ENOENT') {
      throw new NgitCliMissingError()
    }
    throw new Error(
      ngitErrorMessage(
        String(failure.stdout ?? ''),
        String(failure.stderr ?? ''),
        error instanceof Error ? error.message : 'ngit failed.'
      )
    )
  }
}
