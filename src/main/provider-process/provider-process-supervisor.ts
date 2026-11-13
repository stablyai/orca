import { resolveProviderChildEnv, type ProviderProcessLaunch } from './provider-process-launch'

import {
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SIGTERM_GRACE_MS
} from './provider-process-supervisor-script'
export * from './provider-process-supervisor-script'

/** Session stdin-end requests close; one-shot stdin-end only completes the request. */
export type ProviderSupervisorLifetime = 'session' | 'one-shot'

/** Owner death repeats this close request, including optional immediate SIGTERM. */
export type ProviderCloseRequest = 'stdin-end' | 'stdin-end-and-sigterm'

export type ProviderSupervisorOptions = {
  cwd?: string
  lifetime?: ProviderSupervisorLifetime
  /** Defaults to the immediate stop; a provider that drains on its stdin end opts into 'stdin-end'. */
  closeRequest?: ProviderCloseRequest
  /** The process the supervisor serves; it must be the supervisor's parent. */
  ownerPid?: number
  stdinEndGraceMs?: number
  sigtermGraceMs?: number
}

// Keep user Node startup options on the provider, outside the Electron supervisor bootstrap.
const PROVIDER_ONLY_NODE_ENV_KEYS = ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'] as const

// A longer grace than the max stop allows would let recovery or close SIGKILL mid-stop.
function assertGraceWithin(name: string, graceMs: number, maxMs: number): void {
  if (!(graceMs >= 0 && graceMs <= maxMs)) {
    throw new RangeError(`Provider supervisor ${name} grace ${graceMs} ms is outside 0-${maxMs} ms`)
  }
}

// `never` makes an env-bearing launch a type error here: env is resolved before supervision.
type ProviderSupervisedCommand = Pick<ProviderProcessLaunch, 'command' | 'args' | 'cwd'> & {
  env?: never
  envToDelete?: never
}

export function supervisedPosixLaunch(
  launch: ProviderSupervisedCommand,
  childEnv: NodeJS.ProcessEnv,
  {
    cwd = launch.cwd ?? process.cwd(),
    ownerPid = process.pid,
    lifetime = 'session',
    closeRequest = 'stdin-end-and-sigterm',
    stdinEndGraceMs = PROVIDER_STDIN_END_GRACE_MS,
    sigtermGraceMs = PROVIDER_SIGTERM_GRACE_MS
  }: ProviderSupervisorOptions = {}
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  assertGraceWithin('stdin-end', stdinEndGraceMs, PROVIDER_STDIN_END_GRACE_MS)
  assertGraceWithin('SIGTERM', sigtermGraceMs, PROVIDER_SIGTERM_GRACE_MS)
  // Keep prompts in argv: Linux caps individual env strings at 128 KiB; Node startup options belong only in the spec.
  const supervisorEnv = { ...childEnv }
  const nodeEnv: Record<string, string> = {}
  for (const key of PROVIDER_ONLY_NODE_ENV_KEYS) {
    const value = supervisorEnv[key]
    delete supervisorEnv[key]
    if (value !== undefined) {
      nodeEnv[key] = value
    }
  }
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      cwd,
      ownerPid,
      lifetime,
      closeRequest,
      stdinEndGraceMs,
      sigtermGraceMs,
      nodeEnv
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT, '--', launch.command, ...launch.args],
    // Only the supervisor needs Electron Node mode; the provider env above strips this marker.
    env: {
      ...supervisorEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    }
  }
}

export function createProviderSpawnSpec(
  launch: ProviderProcessLaunch,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  { lifetime, closeRequest }: Pick<ProviderSupervisorOptions, 'lifetime' | 'closeRequest'> = {}
): {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
  /** The child is the supervisor, whose SIGTERM stops the provider and then itself. */
  supervised: boolean
  /** IPC group-report channel appended after stdin/stdout/stderr. */
  groupReportStdio: [] | ['ipc']
} {
  const childEnv = resolveProviderChildEnv(launch, baseEnv)
  const supervisor =
    platform === 'win32'
      ? null
      : supervisedPosixLaunch(
          { command: launch.command, args: launch.args, cwd: launch.cwd },
          childEnv,
          { lifetime, closeRequest }
        )
  return {
    program: supervisor?.command ?? launch.command,
    args: supervisor?.args ?? launch.args,
    env: supervisor?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32',
    supervised: supervisor !== null,
    groupReportStdio: supervisor ? ['ipc'] : []
  }
}
