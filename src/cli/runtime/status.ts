import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { findTransport } from '../../shared/runtime-bootstrap'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import {
  projectRemoteAppStatus,
  resolveDesktopWindowStatus
} from '../../shared/cli-app-status-projection'
import { RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'

export { projectRemoteAppStatus, resolveDesktopWindowStatus }

export async function getCliStatus(
  userDataPath: string
): Promise<RuntimeRpcSuccess<CliStatusResult>> {
  const metadata = tryReadMetadata(userDataPath)
  const transport = metadata ? findTransport(metadata, 'unix', 'named-pipe') : null
  if (!transport || !metadata?.authToken) {
    const pidVerdict = classifyProcess(metadata?.pid)
    return buildCliStatusResponse({
      app: {
        running: false,
        pid: null
      },
      runtime: {
        // Why: distinguishing "never started" from "was running but died"
        // gives the user a better signal about what happened. If the metadata
        // file exists, Orca was running at some point.
        state: metadata ? 'stale_bootstrap' : 'not_running',
        reachable: false,
        runtimeId: null,
        bootstrap: buildBootstrapDiagnostics(
          userDataPath,
          metadata,
          transport,
          pidVerdict,
          metadata ? 'metadata_incomplete' : 'metadata_missing',
          metadata ? 'verify_profile_and_integrity' : 'start_orca'
        )
      },
      graph: {
        state: 'not_running'
      }
    })
  }

  try {
    const response = await sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, 1000)
    if (response.ok === false) {
      throw new RuntimeRpcFailureError(response)
    }
    const graphState = response.result.graphStatus
    const desktopWindowStatus = resolveDesktopWindowStatus(response.result)
    return buildCliStatusResponse({
      app: {
        running: true,
        pid: metadata.pid,
        ...(desktopWindowStatus ? { desktopWindowStatus } : {})
      },
      runtime: {
        state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
        reachable: true,
        runtimeId: response.result.runtimeId,
        ...(response.result.appVersion ? { appVersion: response.result.appVersion } : {}),
        ...(response.result.remoteUpdateSupport
          ? { remoteUpdateSupport: response.result.remoteUpdateSupport }
          : {}),
        ...(response.result.capabilities ? { capabilities: response.result.capabilities } : {}),
        ...(response.result.degradations ? { degradations: response.result.degradations } : {})
      },
      graph: {
        state: graphState
      }
    })
  } catch {
    const pidVerdict = classifyProcess(metadata.pid)
    const running = pidVerdict === 'live'
    const unverifiable = pidVerdict === 'unverifiable'
    return buildCliStatusResponse({
      app: {
        running,
        pid: running ? metadata.pid : null
      },
      runtime: {
        state: running || unverifiable ? 'starting' : 'stale_bootstrap',
        reachable: false,
        runtimeId: null,
        bootstrap: buildBootstrapDiagnostics(
          userDataPath,
          metadata,
          transport,
          pidVerdict,
          running
            ? 'runtime_starting'
            : unverifiable
              ? 'runtime_process_unverifiable'
              : 'runtime_process_exited',
          unverifiable ? 'verify_profile_and_integrity' : 'restart_and_query_back'
        )
      },
      graph: {
        state: running || unverifiable ? 'starting' : 'not_running'
      }
    })
  }
}

function buildBootstrapDiagnostics(
  userDataPath: string,
  metadata: ReturnType<typeof tryReadMetadata>,
  transport: ReturnType<typeof findTransport>,
  pidVerdict: NonNullable<CliStatusResult['runtime']['bootstrap']>['pidVerdict'],
  reason: NonNullable<CliStatusResult['runtime']['bootstrap']>['reason'],
  recoveryCode: NonNullable<CliStatusResult['runtime']['bootstrap']>['recoveryCode']
): NonNullable<CliStatusResult['runtime']['bootstrap']> {
  return {
    observedAt: new Date().toISOString(),
    userDataPath,
    profileSource:
      process.env.ORCA_USER_DATA_PATH === userDataPath
        ? 'env'
        : process.env.ORCA_USER_DATA_PATH
          ? 'explicit'
          : 'default',
    metadataPath: getRuntimeMetadataPath(userDataPath),
    metadataPresent: Boolean(metadata),
    metadataRuntimeId: metadata?.runtimeId ?? null,
    metadataPid: metadata?.pid ?? null,
    pidVerdict,
    transportKind: transport?.kind ?? null,
    reason,
    verification: { kind: 'process_signal_0', result: pidVerdict },
    recoveryCode,
    recovery: [
      'Confirm the CLI and desktop app use the same user-data path and OS user.',
      'Restart Orca, then run `orca status --json` and require a new reachable runtimeId.'
    ]
  }
}

function buildCliStatusResponse(result: CliStatusResult): RuntimeRpcSuccess<CliStatusResult> {
  return {
    id: 'local-status',
    ok: true,
    result: { target: { kind: 'local' }, ...result },
    _meta: {
      runtimeId: result.runtime.runtimeId ?? 'none'
    }
  }
}

export function classifyProcess(
  pid: number | null | undefined,
  probe: (pid: number, signal: 0) => void = process.kill.bind(process)
): NonNullable<CliStatusResult['runtime']['bootstrap']>['pidVerdict'] {
  if (!pid || pid <= 0) {
    return 'unverifiable'
  }
  try {
    probe(pid, 0)
    return 'live'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'unverifiable'
  }
}
