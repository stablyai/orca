import { compareAppVersions, parseCliVersion } from '../shared/app-version'
import { runProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'

function warnRefused(program: string, why: string, output = ''): void {
  const said = output.trim().replace(/\s+/g, ' ').slice(0, 200)
  console.warn(`[agent-cli-version] ${program} --version: ${why}${said ? `: ${said}` : ''}`)
}

/** Unknown versions permit launch; missing means the program never started. */
export type AgentCliVersionCheck =
  | { status: 'ready'; version: string }
  | { status: 'tooOld'; version: string; minimumVersion: string }
  | { status: 'unknown' | 'missing'; version: null }

export type AgentCliVersionReader = (
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>
) => Promise<{ version: string | null; started?: false }>

export async function checkAgentCliVersion(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>,
  minimumVersions: readonly string[],
  read: AgentCliVersionReader = readAgentCliVersion
): Promise<AgentCliVersionCheck> {
  const { version, started } = await read(input)
  if (version === null) {
    return { status: started === false ? 'missing' : 'unknown', version: null }
  }
  const minimumVersion = agentCliMinimumVersion(version, minimumVersions)
  if (minimumVersion !== null && compareAppVersions(version, minimumVersion) < 0) {
    warnRefused(input.program, `${version} is older than ${minimumVersion}`)
    return { status: 'tooOld', version, minimumVersion }
  }
  console.info(`[agent-cli-version] ${input.program} --version: ${version} is supported`)
  return { status: 'ready', version }
}

export function launchableRelease(check: AgentCliVersionCheck): boolean {
  return check.status === 'ready' || check.status === 'unknown'
}

/** Use the last floor at or below the release major, or the first floor for older majors. */
export function agentCliMinimumVersion(
  version: string,
  minimumVersions: readonly string[]
): string | null {
  const major = (value: string): number => Number(value.split('.')[0])
  return (
    minimumVersions.findLast((minimum) => major(minimum) <= major(version)) ??
    minimumVersions[0] ??
    null
  )
}

export async function readAgentCliVersion(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>,
  parseVersion: typeof parseCliVersion = parseCliVersion
): Promise<{ version: string | null; started?: false }> {
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
    return { version: null, started: false }
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
  const version = parseVersion(output)
  if (version === null) {
    warnRefused(input.program, 'printed no version', output)
    return { version: null }
  }
  return { version }
}
