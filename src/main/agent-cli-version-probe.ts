import {
  hasReachedAppVersion,
  isPrereleaseAppVersion,
  parseCliVersion
} from '../shared/app-version'
import { runProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'

/** One line naming why a probe said no; the binary's own words, bounded. */
function warnRefused(program: string, why: string, output = ''): void {
  const said = output.trim().replace(/\s+/g, ' ').slice(0, 200)
  console.warn(`[agent-cli-version] ${program} --version: ${why}${said ? `: ${said}` : ''}`)
}

/** Runs `<program> --version` on this host and asks `supports` about the version it prints. False
 *  when it cannot tell: a failed spawn, a non-zero exit, a timeout, or output with no version. */
export async function probeAgentCliVersion(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>,
  supports: (version: string) => boolean
): Promise<boolean> {
  const result = await readAgentCliVersion(input)
  if (result.version === null) {
    return false
  }
  if (!supports(result.version)) {
    warnRefused(input.program, `${result.version} is not a supported release`)
    return false
  }
  console.info(`[agent-cli-version] ${input.program} --version: ${result.version} is supported`)
  return true
}

export async function readAgentCliVersion(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>,
  parseVersion: typeof parseCliVersion = parseCliVersion
): Promise<{ version: string | null }> {
  let result
  try {
    result = await runProcess({
      ...input,
      args: ['--version'],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
  } catch (error) {
    warnRefused(input.program, `did not start (${String(error)})`)
    return { version: null }
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (result.timedOut || result.outputTruncated || result.code !== 0) {
    const why = result.timedOut
      ? 'timed out'
      : result.outputTruncated
        ? 'printed too much'
        : `exited ${result.code ?? result.signal}`
    warnRefused(input.program, why, output)
    return { version: null }
  }
  const version = parseVersion(parseVersion === parseCliVersion ? result.stdout : output)
  if (version === null) {
    warnRefused(input.program, 'printed no version', output)
    return { version: null }
  }
  return { version }
}

/** A stable release at or after `floor`, on any later major line too. */
export function isStableCliVersionFrom(version: string, floor: string): boolean {
  return !isPrereleaseAppVersion(version) && hasReachedAppVersion(version, floor)
}

/** A stable release on `major`'s line, at or after `floor`. */
export function isStableCliVersionOnLine(
  version: string,
  line: { major: number; floor: string }
): boolean {
  return version.startsWith(`${line.major}.`) && isStableCliVersionFrom(version, line.floor)
}
