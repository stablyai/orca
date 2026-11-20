import type { StructuredAgentResolutionOperation } from '../../native-chat/agent-launch/structured-agent-command-resolution'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  checkAgentCliVersion,
  launchableRelease,
  type AgentCliVersionCheck,
  type AgentCliVersionReader
} from '../../agent-launch/preflight/agent-cli-version-probe'
import type { AcpLaunchSpec, ManagedCopySettings } from './acp-launch-contract'
import { managedAgentCommandFor } from '../../managed-agent-cli/managed-agent-cli-registry'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { noteAcpForkVersion } from '../capabilities/acp-fork-support'

export async function checkAcpLaunchVersion(
  spec: AcpLaunchSpec,
  launch: Pick<AcpStructuredLaunch, 'command' | 'prefixArgs' | 'cwd' | 'env'> & {
    operation?: StructuredAgentResolutionOperation
  },
  wantVersion: boolean,
  read?: AgentCliVersionReader
): Promise<AgentCliVersionCheck> {
  if (!spec.minimumVersions && !wantVersion) {
    noteAcpForkVersion(spec.agent, null)
    return { status: 'unknown', version: null }
  }
  const result = await checkAgentCliVersion(
    {
      program: launch.command,
      prefixArgs: [...launch.prefixArgs, ...(spec.versionArgs ?? [])],
      cwd: launch.cwd,
      env: launch.env,
      operation: launch.operation
    },
    spec.minimumVersions ?? [],
    read
  )
  noteAcpForkVersion(spec.agent, result.version)
  return result
}

/** Orca's copy that serves when `command` is too old, or null where the spec doesn't let it run. */
export function acpStandInCopy(
  spec: Pick<AcpLaunchSpec, 'agent' | 'command' | 'managedCopyAllowed'>,
  command: string,
  settings: ManagedCopySettings | undefined
): string | null {
  if (!spec.managedCopyAllowed?.(settings ?? {})) {
    return null
  }
  const copy = managedAgentCommandFor(spec.agent, spec.command)
  return copy && copy !== command ? copy : null
}

/** The launch's version check, standing Orca's copy in for a user's own program that is too old,
 *  where the spec lets Orca's copy run: an own agy older than the floor would refuse every chat
 *  that Orca's current copy can serve. */
export async function checkAcpLaunchVersionOrCopy(
  spec: AcpLaunchSpec,
  launch: Parameters<typeof checkAcpLaunchVersion>[1],
  wantVersion: boolean,
  read: AgentCliVersionReader | undefined,
  settings: ManagedCopySettings | undefined
): Promise<{ command: string; prefixArgs: string[]; check: AgentCliVersionCheck }> {
  const check = await checkAcpLaunchVersion(spec, launch, wantVersion, read)
  const copy = check.status === 'tooOld' ? acpStandInCopy(spec, launch.command, settings) : null
  if (!copy) {
    return { command: launch.command, prefixArgs: launch.prefixArgs, check }
  }
  const copyCheck = await checkAcpLaunchVersion(
    spec,
    { ...launch, command: copy, prefixArgs: [] },
    wantVersion,
    read
  )
  // A copy that is missing or itself too old helps nobody; the own program's answer stands.
  return launchableRelease(copyCheck)
    ? { command: copy, prefixArgs: [], check: copyCheck }
    : { command: launch.command, prefixArgs: launch.prefixArgs, check }
}

// Keyed by path; the binary's size and mtime tell an upgrade apart. A read that settled nothing
// (timed out, blocked, missing) is asked again after a minute instead of standing for good.
type OwnVersionRead = {
  identity: string
  tooOld: Promise<boolean | null>
  settled?: boolean
  retryAt?: number
}
const ownVersions = new Map<string, OwnVersionRead>()
const UNSETTLED_RETRY_MS = 60_000

/** Whether a person's own `program` is older than the spec's floor, so Orca's copy serves in its
 *  place; read once per binary. Without `probe` it answers only from an earlier read, starting
 *  nothing. With `onLateAnswer` it doesn't wait for a first read: it answers false now and calls
 *  back once that read finds the program too old. */
export async function acpOwnProgramTooOld(
  spec: Pick<AcpLaunchSpec, 'minimumVersions' | 'versionArgs'>,
  program: string,
  env: Record<string, string>,
  { probe, onLateAnswer }: { probe: boolean; onLateAnswer?: () => void },
  now: () => number = Date.now
): Promise<boolean> {
  if (!spec.minimumVersions) {
    return false
  }
  const stats = await stat(program).catch(() => null)
  if (!stats?.isFile()) {
    return false
  }
  const identity = `${stats.size}:${stats.mtimeMs}`
  const known = ownVersions.get(program)
  const current =
    known?.identity === identity && (known.retryAt === undefined || now() < known.retryAt)
  if (!current && !probe) {
    return false
  }
  const read: OwnVersionRead = current
    ? known
    : {
        identity,
        tooOld: checkAgentCliVersion(
          {
            program,
            prefixArgs: [...(spec.versionArgs ?? [])],
            cwd: env.HOME ?? env.USERPROFILE ?? homedir(),
            env
          },
          spec.minimumVersions
        ).then(
          (check) => (check.status === 'tooOld' ? true : check.status === 'ready' ? false : null),
          () => null
        )
      }
  if (!current) {
    ownVersions.set(program, read)
    void read.tooOld.then((tooOld) => {
      read.settled = true
      read.retryAt = tooOld === null ? now() + UNSETTLED_RETRY_MS : undefined
    })
  }
  if (onLateAnswer && !read.settled) {
    void read.tooOld.then((tooOld) => tooOld && onLateAnswer())
    return false
  }
  return (await read.tooOld) === true
}
