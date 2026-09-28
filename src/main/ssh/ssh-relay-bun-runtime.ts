import { randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { ORCAD_BUN_RELEASE_ASSETS } from '../../shared/orcad-bun-runtime'
import { materializeCachedOrcadBunRuntime } from './orcad-bun-runtime-materializer'
import { resolveOrcadDeploymentTarget } from './orcad-deployment-target'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import type { SshConnection } from './ssh-connection'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { createRelayInstallMarkerFileName } from './ssh-relay-install-marker'
import {
  createRelayUploadStageNamespace,
  relayUploadStageSftpNamespaceMapping
} from './ssh-relay-install-namespace'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  cleanupOwnedRelayUploadStageCommand,
  parseReservedRelayUploadStage,
  recoverOneStaleRelayUploadStageCommand,
  reserveRelayUploadStageCommand,
  RELAY_UPLOAD_STAGE_POOL_NAME
} from './ssh-relay-upload-stage-commands'
import {
  parseRelayBunRuntimeResult,
  probeRelayBunRuntimeCommand,
  promoteRelayBunRuntimeCommand
} from './ssh-relay-bun-runtime-commands'

/** Bootstrap the relay executable without executing or requiring host Node/npm. */
export async function ensureRemoteRelayBunRuntime(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: { signal?: AbortSignal; cacheRoot?: string } = {}
): Promise<string> {
  // Cold runtime uploads share the deployment budget, including on slow links.
  const timeout = AbortSignal.timeout(RELAY_DEPLOY_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const generation = conn.getConnectGeneration()
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (conn.getConnectGeneration() !== generation) {
      throw new Error('SSH connection changed during Bun runtime installation')
    }
  }
  const exec = async (command: string): Promise<string> => {
    assertCurrent()
    const output = await execCommand(conn, command, {
      signal,
      wrapCommand: !isWindowsRemoteHost(host)
    })
    assertCurrent()
    return output
  }
  const target = await resolveOrcadDeploymentTarget({ conn, host, signal, exec })
  const expectedHash = ORCAD_BUN_RELEASE_ASSETS[target].executableSha256
  const binary = isWindowsRemoteHost(host) ? 'bun.exe' : 'bun'
  // Runtime paths outlive version GC so live and older relays can still spawn children.
  const executable = joinRemotePath(
    host,
    remoteHome,
    RELAY_REMOTE_DIR,
    'runtimes',
    expectedHash,
    binary
  )
  const cached = parseRelayBunRuntimeResult(
    await exec(probeRelayBunRuntimeCommand(host, executable, expectedHash))
  )
  if (cached) {
    return cached
  }
  const localRuntime = await materializeCachedOrcadBunRuntime(
    target,
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
    { signal }
  )
  assertCurrent()
  const relativePool = `${RELAY_REMOTE_DIR}/${RELAY_UPLOAD_STAGE_POOL_NAME}`
  const pool = joinRemotePath(host, remoteHome, relativePool)
  const owner = createRelayInstallMarkerFileName()
  await exec(recoverOneStaleRelayUploadStageCommand(host, pool))
  const stage = parseReservedRelayUploadStage(
    host,
    pool,
    owner,
    await exec(reserveRelayUploadStageCommand(host, pool, owner))
  )
  const namespace = createRelayUploadStageNamespace(`${relativePool}/${stage.slotName}`, owner)
  let localStage: string | undefined
  let cleanupAllowed = true
  try {
    localStage = await mkdtemp(join(dirname(localRuntime), '.relay-bun-upload-'))
    await copyFile(localRuntime, join(localStage, binary))
    assertCurrent()
    await uploadRelayDirectory(
      conn,
      localStage,
      joinRemotePath(host, stage.slotDir, 'payload'),
      host,
      {
        signal,
        sftpNamespace:
          !isWindowsRemoteHost(host) && conn.usesSystemSshTransport?.() !== true
            ? relayUploadStageSftpNamespaceMapping(namespace, host, stage.slotDir)
            : undefined
      }
    )
    assertCurrent()
    const published = parseRelayBunRuntimeResult(
      await exec(
        promoteRelayBunRuntimeCommand({
          host,
          source: joinRemotePath(host, stage.slotDir, 'payload', binary),
          executable,
          expectedHash,
          repairToken: randomBytes(12).toString('hex')
        })
      )
    )
    if (!published) {
      throw new Error('The host did not publish the verified Bun runtime')
    }
    return published
  } catch (error) {
    cleanupAllowed = !isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (localStage) {
      await rm(localStage, { recursive: true, force: true }).catch(() => {})
    }
    if (cleanupAllowed && !signal.aborted && conn.getConnectGeneration() === generation) {
      await exec(cleanupOwnedRelayUploadStageCommand(host, stage, owner)).catch(
        (error: unknown) => {
          if (isUnconfirmedSshCommandTermination(error)) {
            throw error
          }
        }
      )
    }
  }
}
