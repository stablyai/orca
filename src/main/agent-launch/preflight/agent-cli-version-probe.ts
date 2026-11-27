import { access, constants } from 'node:fs/promises'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
import {
  compareAppVersions,
  parseCliVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import { runProcess } from '@orca/process-host'
import { agentCliMinimumVersion } from './agent-cli-minimum-version'
import { isPermissionError } from '../../filesystem/permission-errors'
import type { ProcessSpec } from '@orca/process-host/process-spec'

function warnRefused(program: string, why: string, output = ''): void {
  const said = output.trim().replace(/\s+/g, ' ').slice(0, 200)
  console.warn(`[agent-cli-version] ${program} --version: ${why}${said ? `: ${said}` : ''}`)
}

/** Unknown versions permit launch; missing means the program never started; cwdAccessDenied, that it could not enter its cwd. */
export type AgentCliVersionCheck =
  | { status: 'ready'; version: string }
  | { status: 'tooOld'; version: string; minimumVersion: string }
  | { status: 'unknown' | 'missing' | 'cwdAccessDenied'; version: null }

export type AgentCliVersionInput = Pick<ProcessSpec, 'program' | 'cwd' | 'env'> & {
  operation?: StructuredAgentResolutionOperation
  timeoutMs?: number | null
  prefixArgs?: readonly string[]
}

export type AgentCliVersionReader = (
  input: AgentCliVersionInput
) => Promise<{ version: string | null; started?: false; cwdAccessDenied?: true }>

export async function checkAgentCliVersion(
  input: AgentCliVersionInput,
  minimumVersions: readonly string[],
  read: AgentCliVersionReader = readAgentCliVersion
): Promise<AgentCliVersionCheck> {
  const { version, started, cwdAccessDenied } = await read(input)
  if (version === null) {
    if (cwdAccessDenied) {
      return { status: 'cwdAccessDenied', version: null }
    }
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

/** A spawn's chdir runs before exec, so a denied spawn in an unsearchable cwd is the folder's fault. */
async function cwdDenied(cwd: string | undefined, spawnError: unknown): Promise<boolean> {
  if (!cwd || !isPermissionError(spawnError)) {
    return false
  }
  return access(cwd, constants.X_OK).then(() => false, isPermissionError)
}

export async function readAgentCliVersion(
  input: AgentCliVersionInput,
  parseVersion: typeof parseCliVersion = parseCliVersion
): Promise<{ version: string | null; started?: false; cwdAccessDenied?: true }> {
  const { prefixArgs = [], operation, timeoutMs = 5_000, ...launch } = input
  assertStructuredAgentResolutionCurrent(operation)
  let result
  try {
    result = await runProcess({
      ...launch,
      args: [...prefixArgs, '--version'],
      terminationBarrier: true,
      signal: operation?.signal,
      timeoutMs:
        timeoutMs === null
          ? null
          : Math.max(
              1,
              Math.min(
                timeoutMs,
                operation?.deadline === undefined ? Infinity : operation.deadline - Date.now()
              )
            ),
      maxOutputBytes: 4_096,
      killOnOutputLimit: true
    })
  } catch (error) {
    const cwdAccessDenied = await cwdDenied(launch.cwd, error)
    assertStructuredAgentResolutionCurrent(operation)
    if (cwdAccessDenied) {
      warnRefused(input.program, `cannot enter its working directory (${String(error)})`)
      return { version: null, started: false, cwdAccessDenied }
    }
    warnRefused(input.program, `did not start (${String(error)})`)
    return { version: null, started: false }
  }
  assertStructuredAgentResolutionCurrent(operation)
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
