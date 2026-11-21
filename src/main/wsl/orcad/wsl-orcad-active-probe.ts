/**
 * WSL reads an active slot's liveness, readiness and pid in one guest command; SSH keeps
 * `probeActiveOrcadReadiness`'s separate reads. The answers are judged exactly as those are.
 */
import type { OrcadHostTarget } from '../../managed-server/install/orcad-host-transport'
import type { OrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import { orcadLivenessProbeCommand } from '../../managed-server/install/orcad-remote-launch'
import { readOrcadReadinessNowCommand } from '../../managed-server/install/orcad-remote-readiness-wait'
import { execOrcadRemote } from '../../managed-server/install/orcad-remote-runtime-control'
import { ORCAD_PID_FILENAME } from '../../managed-server/install/orcad-remote-host-support'
import { managedOrcadInstallDir } from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import {
  activeOrcadReadinessFromOutput,
  assertActiveOrcadLive,
  OrcadActiveReadinessError
} from '../../managed-server/activation/orcad-active-readiness'
import { computeLocalOrcadBuildHash } from '../../managed-server/install/orcad-local-build-hash'
import type { ServeReadiness } from '../../server/serve-readiness'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { ORCAD_WSL_HOST_ENV } from '../../../shared/remote-runtime/serve-supervisor/orcad-server-launch-env'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { joinRemotePath } from '../../ssh/remote-host/ssh-remote-platform'

const SECTION_END = '__ORCA_WSL_ACTIVE_PROBE_END__'
const WSL_HOST_LAUNCH = '__ORCA_WSL_HOST_LAUNCH__'
const OTHER_LAUNCH = '__ORCA_OTHER_LAUNCH__'

/**
 * How the serving orcad was started: by a WSL host (it carries the marker), some other way
 * (usually an SSH host pointed at the distro, #43632), or unknown when its environment is unreadable.
 */
export type WslOrcadLaunchMode = 'wsl-host' | 'other' | 'unknown'

type WslContext = OrcadRemoteContext<OrcadHostTarget>

function pidFile(context: WslContext, fullVersion: string): string {
  return quotePosixShell(
    joinRemotePath(context.host, managedOrcadInstallDir(context, fullVersion), ORCAD_PID_FILENAME)
  )
}

function pidCommand(context: WslContext, fullVersion: string): string {
  return `cat ${pidFile(context, fullVersion)} 2>/dev/null || true`
}

/** The readiness file says nothing of the launch, so read the process's own environment. */
function launchModeCommand(context: WslContext, fullVersion: string): string {
  const environ = '"/proc/$orcad_lp/environ"'
  return (
    `orcad_lp=$(cat ${pidFile(context, fullVersion)} 2>/dev/null); case "$orcad_lp" in "" | *[!0-9]*) ;; ` +
    `*) if [ -r ${environ} ]; then if tr '\\0' '\\n' < ${environ} | ` +
    `grep -qx ${quotePosixShell(`${ORCAD_WSL_HOST_ENV}=1`)}; then echo ${WSL_HOST_LAUNCH}; ` +
    `else echo ${OTHER_LAUNCH}; fi; fi;; esac`
  )
}

function parseLaunchMode(output: string): WslOrcadLaunchMode {
  // A pid file without its newline runs the pid and the answer together.
  return output.includes(WSL_HOST_LAUNCH)
    ? 'wsl-host'
    : output.includes(OTHER_LAUNCH)
      ? 'other'
      : 'unknown'
}

function parsePid(output: string): number | null {
  const pid = Number.parseInt(output, 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export async function readWslOrcadPid(
  context: WslContext,
  fullVersion: string,
  signal?: AbortSignal
): Promise<number | null> {
  return parsePid(
    await execCommand(context.connection, pidCommand(context, fullVersion), { signal })
  )
}

/** Each section ends with a marker on its own line; the newline before it is the probe's own. */
export function wslOrcadActiveProbeCommand(context: WslContext, fullVersion: string): string {
  const installDir = managedOrcadInstallDir(context, fullVersion)
  const end = `printf '\\n%s\\n' ${SECTION_END}`
  return [
    orcadLivenessProbeCommand(context.host, installDir),
    end,
    readOrcadReadinessNowCommand(context.host, installDir),
    end,
    pidCommand(context, fullVersion),
    // Same section as the pid: parsePid reads only its first number.
    launchModeCommand(context, fullVersion)
  ].join('\n')
}

export async function probeWslActiveOrcad(
  context: WslContext,
  localOrcadDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<{ readiness: ServeReadiness; pid: number | null; launch: WslOrcadLaunchMode }> {
  const output = await execOrcadRemote(
    { conn: context.connection, host: context.host, signal },
    wslOrcadActiveProbeCommand(context, fullVersion)
  )
  const sections = output.split(`\n${SECTION_END}\n`)
  if (sections.length !== 3) {
    throw new OrcadActiveReadinessError(
      'unverifiable',
      `orcad ${fullVersion} process state is unverifiable.`
    )
  }
  const [liveness = '', readiness = '', pid = ''] = sections
  const expectation = { buildHash: computeLocalOrcadBuildHash(localOrcadDir), fullVersion }
  assertActiveOrcadLive(liveness, expectation)
  return {
    readiness: activeOrcadReadinessFromOutput(context.host, readiness, expectation),
    pid: parsePid(pid),
    launch: parseLaunchMode(pid)
  }
}
