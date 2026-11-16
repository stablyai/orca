/**
 * WSL reads an active slot's liveness, readiness and pid in one guest command: the POSIX active
 * probe plus the pid. The answers are judged exactly as `probeActiveOrcadReadiness` judges them.
 */
import type { OrcadHostTarget } from '../../managed-server/install/orcad-host-transport'
import type { OrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import { execOrcadRemote } from '../../managed-server/install/orcad-remote-runtime-control'
import { ORCAD_PID_FILENAME } from '../../managed-server/install/orcad-remote-host-support'
import { managedOrcadInstallDir } from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import {
  activeOrcadReadinessFromOutput,
  assertActiveOrcadLive,
  orcadActiveProbeCommand,
  OrcadActiveReadinessError,
  ORCAD_ACTIVE_PROBE_SECTION_END
} from '../../managed-server/activation/orcad-active-readiness'
import { computeLocalOrcadBuildHash } from '../../managed-server/install/orcad-local-build-hash'
import type { ServeReadiness } from '../../server/serve-readiness'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { joinRemotePath } from '../../ssh/remote-host/ssh-remote-platform'

const SECTION_END = ORCAD_ACTIVE_PROBE_SECTION_END

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
  return [
    orcadActiveProbeCommand(context.host, managedOrcadInstallDir(context, fullVersion)),
    `printf '\\n%s\\n' ${SECTION_END}`,
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
