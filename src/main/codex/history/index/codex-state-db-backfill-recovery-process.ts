import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { withCliRuntimeOnPath } from '../../../../shared/shell/command-resolution/node-cli-command-resolution'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { buildWslCodexAppServerArgs } from '../../../codex-cli/wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../../../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../../../codex-cli/codex-probe-termination'
import {
  createProviderSpawnSpec,
  type ProviderCloseRequest
} from '../../../provider-process/provider-process-supervisor'
import type { CodexAppServerSpawn } from '../../app-server/codex-app-server-process-tree-kill'
import { stopSupervisedChildProcess } from '../../../provider-process/supervised-child-process-stop'
import { spawnProviderProcess } from '../../../provider-process/provider-process-spawn'
import { resolveWslInteropSpawnCwd } from '../../../wsl/execution/wsl-interop-spawn-directory'

const BACKFILL_RECOVERY_KILL_SITE = 'codex-state-db-backfill-recovery'
// Keep owner-death and explicit shutdown on the same stdin-drain policy.
const BACKFILL_RECOVERY_CLOSE_REQUEST: ProviderCloseRequest = 'stdin-end'

export type CodexBackfillRecoveryChild = Pick<
  ChildProcess,
  'pid' | 'kill' | 'stdin' | 'exitCode' | 'signalCode'
> &
  EventEmitter

export type CodexBackfillRecoveryProcess = {
  child: CodexBackfillRecoveryChild
  supervised: boolean
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
    return { child, supervised: false }
  }
  const command = resolveCommand()
  // The POSIX watcher stops this long-lived child even if Orca crashes.
  const spawnSpec = createProviderSpawnSpec(
    { command, args: [...CODEX_READ_ONLY_APP_SERVER_ARGS], cwd: codexHomePath },
    withCliRuntimeOnPath(command, {
      ...process.env,
      CODEX_HOME: codexHomePath
    }),
    process.platform,
    { lifetime: 'session', closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST }
  )
  const child = spawnProviderProcess(spawnSpec, (spec) =>
    spawnProcess(spec.program, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      stdio: spec.stdio,
      windowsHide: true,
      env: spec.env,
      detached: spec.detached,
      closeInheritedFds: spec.closeInheritedFds
    })
  )
  child.stdout.resume()
  child.stderr.resume()
  return { child, supervised: spawnSpec.supervised }
}

export async function stopCodexBackfillRecoveryProcess(
  child: CodexBackfillRecoveryChild,
  supervised: boolean
): Promise<void> {
  if (supervised) {
    await stopSupervisedChildProcess(child, {
      site: BACKFILL_RECOVERY_KILL_SITE,
      closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST
    })
    return
  }
  await terminateCodexProbeChild(child)
}
