import {
  createProviderLaunchReport,
  type ProviderLaunchReport
} from '../provider-process/provider-launch-report'
import { acceptProviderWriterClose } from '../provider-process/provider-process-close'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { buildWslCodexAppServerArgs } from '../codex-accounts/wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import {
  createProviderSpawnSpec,
  type ProviderCloseRequest
} from '../provider-process/provider-process-supervisor'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'
import { guardSupervisedProviderGroup } from '../provider-process/provider-group-orphan-guard'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

const BACKFILL_RECOVERY_KILL_SITE = 'codex-state-db-backfill-recovery'
// Keep owner-death and explicit shutdown on the same stdin-drain policy.
const BACKFILL_RECOVERY_CLOSE_REQUEST: ProviderCloseRequest = 'stdin-end'

export type CodexBackfillRecoveryProcess = {
  child: ChildProcessHandle
  supervised: boolean
  launchReport: ProviderLaunchReport
}

export function spawnCodexBackfillRecoveryProcess(
  codexHomePath: string,
  spawnProcess: CodexAppServerSpawn,
  resolveCommand: () => string
): CodexBackfillRecoveryProcess {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  if (wslHome) {
    const child = spawnProcess(
      'wsl.exe',
      buildWslCodexAppServerArgs(
        wslHome.distro,
        wslHome.linuxPath,
        CODEX_READ_ONLY_APP_SERVER_ARGS
      ),
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: process.env,
        cwd: resolveWslInteropSpawnCwd()
      }
    )
    return { child, supervised: false, launchReport: createProviderLaunchReport(child, false) }
  }
  const command = resolveCommand()
  // The POSIX supervisor stops this long-lived child even if Orca crashes.
  const spawnSpec = createProviderSpawnSpec(
    { command, args: [...CODEX_READ_ONLY_APP_SERVER_ARGS], cwd: codexHomePath },
    withCliRuntimeOnPath(command, {
      ...process.env,
      CODEX_HOME: codexHomePath
    }),
    process.platform,
    { lifetime: 'session', closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST }
  )
  const child = spawnProcess(spawnSpec.program, spawnSpec.args, {
    cwd: codexHomePath,
    stdio: ['pipe', 'ignore', 'ignore', ...spawnSpec.groupReportStdio],
    windowsHide: true,
    env: spawnSpec.env,
    ...(spawnSpec.supervised ? { detached: true } : {})
  })
  const launchReport = createProviderLaunchReport(child, spawnSpec.supervised)
  guardSupervisedProviderGroup(child, {
    site: BACKFILL_RECOVERY_KILL_SITE,
    supervised: spawnSpec.supervised,
    report: launchReport
  })
  return { child, supervised: spawnSpec.supervised, launchReport }
}

export async function stopCodexBackfillRecoveryProcess({
  child,
  supervised,
  launchReport
}: CodexBackfillRecoveryProcess): Promise<void> {
  if (supervised) {
    const result = await stopSupervisedChildProcess(child, {
      site: BACKFILL_RECOVERY_KILL_SITE,
      closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST
    })
    if (!acceptProviderWriterClose(result)) {
      throw new Error('Codex backfill recovery process termination was not confirmed')
    }
    launchReport.retire()
    return
  }
  await terminateCodexProbeChild(child)
  launchReport.retire()
}
