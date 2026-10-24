import type { ChildProcessHandle, PipedChildProcess } from '@orca/process-host/process-spec'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { buildWslCodexAppServerArgs } from '../codex-accounts/wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

const BACKFILL_RECOVERY_KILL_SITE = 'codex-state-db-backfill-recovery'
export type CodexBackfillRecoveryProcess = {
  child: ChildProcessHandle
  managed?: ManagedProviderProcess
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
    return { child }
  }
  const command = resolveCommand()
  if (process.platform === 'win32') {
    return {
      child: spawnProcess(command, [...CODEX_READ_ONLY_APP_SERVER_ARGS], {
        cwd: codexHomePath,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: withCliRuntimeOnPath(command, { ...process.env, CODEX_HOME: codexHomePath })
      })
    }
  }
  const managed = spawnManagedProviderProcess(
    {
      command,
      args: [...CODEX_READ_ONLY_APP_SERVER_ARGS],
      cwd: codexHomePath
    },
    {
      site: BACKFILL_RECOVERY_KILL_SITE,
      inheritedEnv: withCliRuntimeOnPath(command, { ...process.env, CODEX_HOME: codexHomePath }),
      spawnImpl: (spec) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this spec supplies three pipe slots to the production spawner.
        spawnProcess(spec.program, [...(spec.args ?? [])], {
          ...spec,
          windowsHide: true
        }) as PipedChildProcess
    }
  )
  managed.child.stdout.resume()
  return { child: managed.child, managed }
}

export async function stopCodexBackfillRecoveryProcess(
  child: ChildProcessHandle,
  managed?: ManagedProviderProcess
): Promise<void> {
  if (managed) {
    await managed.close()
    return
  }
  await terminateCodexProbeChild(child)
}
