/**
 * WSL reads an active slot's liveness, readiness and pid in one guest command; SSH keeps
 * `probeActiveOrcadReadiness`'s separate reads. The answers are judged exactly as those are.
 */
import type { OrcadHostTarget } from '../ssh/orcad-host-transport'
import type { OrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import { orcadLivenessProbeCommand } from '../managed-server/install/orcad-remote-launch'
import { readOrcadReadinessNowCommand } from '../managed-server/install/orcad-remote-readiness-wait'
import { execOrcadRemote } from '../managed-server/install/orcad-remote-runtime-control'
import { ORCAD_PID_FILENAME } from '../managed-server/install/orcad-remote-host-support'
import { managedOrcadInstallDir } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import {
  activeOrcadReadinessFromOutput,
  assertActiveOrcadLive,
  OrcadActiveReadinessError
} from '../ssh/orcad-active-readiness'
import { computeLocalOrcadBuildHash } from '../ssh/orcad-local-build-hash'
import type { ServeReadiness } from '../server/serve-readiness'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { joinRemotePath } from '../ssh/ssh-remote-platform'

const SECTION_END = '__ORCA_WSL_ACTIVE_PROBE_END__'

type WslContext = OrcadRemoteContext<OrcadHostTarget>

function pidCommand(context: WslContext, fullVersion: string): string {
  const pidFile = joinRemotePath(
    context.host,
    managedOrcadInstallDir(context, fullVersion),
    ORCAD_PID_FILENAME
  )
  return `cat ${quotePosixShell(pidFile)} 2>/dev/null || true`
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
    pidCommand(context, fullVersion)
  ].join('\n')
}

export async function probeWslActiveOrcad(
  context: WslContext,
  localOrcadDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<{ readiness: ServeReadiness; pid: number | null }> {
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
    pid: parsePid(pid)
  }
}
