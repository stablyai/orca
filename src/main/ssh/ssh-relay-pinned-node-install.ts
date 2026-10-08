/** Host-side steps of the pinned-Node relay install: the runtime store and the pre-launch self-test. */
import { orcadNodePtyNativeArtifacts } from '../../shared/orcad-artifacts'
import {
  ensureRemoteOrcadNodeRuntime,
  remoteNodeRuntimeDir,
  remoteNodeRuntimePresentCommand,
  RemoteNodeRuntimeSecurityModifiedError,
  RemoteNodeRuntimeSelfTestError,
  REMOTE_NODE_RUNTIME_READY
} from './orcad-remote-node-runtime'
import { withRuntimeStoreLock } from './remote-node-runtime-store-lock'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  isPinnedRuntimeRefusal,
  PinnedRelayFallbackError,
  pinnedRelayNodePath,
  recordPinnedRuntimeRefusal,
  type PinnedRelayPlan
} from './ssh-relay-pinned-node'
import type { PrebuiltRelayPlan } from './ssh-relay-host-node-addons'
import type { RelayRuntimeLadderRun } from './ssh-relay-runtime-resolution'
import {
  classifyPinnedRuntimeFailure,
  runPinnedRuntimeSelfTest
} from './ssh-relay-runtime-self-test'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteDirname,
  type RemoteHostPlatform
} from './ssh-remote-platform'

type PinnedInstallContext = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteRelayDir: string
  plan: PrebuiltRelayPlan
  targetId: string
  signal?: AbortSignal
  run?: RelayRuntimeLadderRun
}

function refuse(context: PinnedInstallContext, error: PinnedRelayFallbackError): never {
  // Only Orca's pinned Node is cached as refused; a host Node refusal names nothing reusable.
  if (context.plan.kind === 'pinned-node' && isPinnedRuntimeRefusal(error.reason)) {
    recordPinnedRuntimeRefusal(context.targetId, context.plan.target, error.reason)
  }
  throw error
}

export function prebuiltRelayNodePath(context: {
  host: RemoteHostPlatform
  remoteRelayDir: string
  plan: PrebuiltRelayPlan
}): string {
  return context.plan.kind === 'pinned-node'
    ? pinnedRelayNodePath(context.host, context.remoteRelayDir, context.plan.target)
    : context.plan.nodePath
}

/**
 * The warm path only checks the verified marker; hashing ~120 MiB on every reconnect would
 * spend the warm-reconnect budget (design D10 G2.6). A cold install verifies in full.
 */
export async function ensurePinnedRelayRuntime(
  context: PinnedInstallContext & { plan: PinnedRelayPlan },
  relayAlreadyInstalled: boolean
): Promise<void> {
  const { conn, host, remoteRelayDir, plan, signal, run } = context
  if (relayAlreadyInstalled) {
    const runtimeDir = remoteNodeRuntimeDir(host, remoteRelayDir, plan.target)
    const present = await execCommand(conn, remoteNodeRuntimePresentCommand(host, runtimeDir), {
      signal,
      wrapCommand: !isWindowsRemoteHost(host)
    })
    if (present.trim() === REMOTE_NODE_RUNTIME_READY) {
      if (run && run.runtimeTransfer === 'none') {
        run.runtimeTransfer = 'cached'
      }
      return
    }
  }
  try {
    const { transfer } = await ensureRemoteOrcadNodeRuntime({
      conn,
      host,
      slotDir: remoteRelayDir,
      target: plan.target,
      archivePath: plan.runtimeArchive,
      signal
    })
    if (run && run.runtimeTransfer !== 'uploaded') {
      run.runtimeTransfer = transfer
    }
  } catch (error) {
    if (error instanceof PinnedRelayFallbackError) {
      refuse(context, error)
    }
    if (error instanceof RemoteNodeRuntimeSecurityModifiedError) {
      refuse(context, new PinnedRelayFallbackError('security_software', error.detail))
    }
    if (error instanceof RemoteNodeRuntimeSelfTestError) {
      const refusal = classifyPinnedRuntimeFailure(error.exitStatus, error.output)
      if (refusal) {
        refuse(context, new PinnedRelayFallbackError(refusal, error.message))
      }
    }
    throw error
  }
}

/**
 * The runtime was ensured before the relay dir carried its ref, so a store GC in between could
 * have collected it. Now that the ref is visible, a check under the store lock is final: GC only
 * deletes while holding that lock, and it never deletes a referenced runtime.
 */
async function confirmPinnedRuntimeHeld(
  context: PinnedInstallContext & { plan: PinnedRelayPlan }
): Promise<void> {
  const { conn, host, remoteRelayDir, plan, signal } = context
  const runtimeDir = remoteNodeRuntimeDir(host, remoteRelayDir, plan.target)
  const present = await withRuntimeStoreLock(
    conn,
    host,
    remoteDirname(runtimeDir, host),
    () =>
      execCommand(conn, remoteNodeRuntimePresentCommand(host, runtimeDir), {
        signal,
        wrapCommand: !isWindowsRemoteHost(host)
      }),
    signal
  )
  if (present.trim() !== REMOTE_NODE_RUNTIME_READY) {
    console.warn(
      `[ssh-relay] Pinned Node runtime vanished before launch; reinstalling ${runtimeDir}`
    )
    await ensurePinnedRelayRuntime(context, false)
  }
}

/** Runs after the payload is promoted and before `.install-complete`, so a refused dir never completes. */
export async function verifyPinnedRelayInstall(context: PinnedInstallContext): Promise<void> {
  const { conn, host, remoteRelayDir, plan, signal } = context
  // Rung C runs no store runtime, so it has nothing store GC can take.
  if (plan.kind === 'pinned-node') {
    await confirmPinnedRuntimeHeld({ ...context, plan })
  }
  const spawnHelpers = orcadNodePtyNativeArtifacts(plan.target).filter((artifact) =>
    artifact.endsWith('/spawn-helper')
  )
  if (spawnHelpers.length > 0) {
    // SFTP drops executable modes; node-pty posix_spawns this helper on macOS.
    await execCommand(
      conn,
      `chmod 755 ${spawnHelpers
        .map((artifact) =>
          shellEscape(joinRemotePath(host, remoteRelayDir, ...artifact.split('/')))
        )
        .join(' ')}`,
      { signal }
    )
  }
  const nodePath = prebuiltRelayNodePath(context)
  const verdict = await runPinnedRuntimeSelfTest(conn, remoteRelayDir, nodePath, signal, {
    host,
    expectPinnedVersion: plan.kind === 'pinned-node'
  })
  if (context.run) {
    context.run.selfTest = verdict.verdict
  }
  switch (verdict.verdict) {
    case 'passed':
      console.log(
        `[ssh-relay] ${plan.kind === 'pinned-node' ? 'Pinned' : 'Host'} Node self-test passed at ${remoteRelayDir} (${verdict.report.node}, glibc ${verdict.report.glibcVersionRuntime ?? 'n/a'})`
      )
      return
    case 'refused':
      refuse(context, new PinnedRelayFallbackError(verdict.refusal, verdict.detail))
      break
    case 'unverifiable':
      // Why rethrow the cause: an unconfirmed teardown must keep the install lock held.
      if (isUnconfirmedSshCommandTermination(verdict.cause)) {
        throw verdict.cause
      }
      throw new Error(
        `The relay runtime self-test at ${remoteRelayDir} is unverifiable; retrying on the next connect: ${verdict.detail}`
      )
    case 'failed':
      throw new Error(`The relay runtime self-test at ${remoteRelayDir} failed: ${verdict.detail}`)
  }
}
