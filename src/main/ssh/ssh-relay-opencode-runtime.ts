import { randomBytes } from 'node:crypto'
import { copyFile, link, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { ORCAD_BUN_RELEASE_ASSETS, type OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import type { SshConnection } from './ssh-connection'
import { resolveOrcadDeploymentTarget } from './orcad-deployment-target'
import { materializeCachedOrcadBunRuntime } from './orcad-bun-runtime-materializer'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  createRelayUploadStageNamespace,
  relayUploadStageSftpNamespaceMapping
} from './ssh-relay-install-namespace'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { createRelayInstallMarkerFileName } from './ssh-relay-install-marker'
import {
  cleanupOwnedRelayUploadStageCommand,
  parseReservedRelayUploadStage,
  recoverOneStaleRelayUploadStageCommand,
  reserveRelayUploadStageCommand,
  RELAY_UPLOAD_STAGE_POOL_NAME
} from './ssh-relay-upload-stage-commands'
import {
  parseOpenCodeRuntimeResult,
  probeOpenCodeRuntimeCacheCommand,
  probeOpenCodeNodeSqliteCommand,
  promoteOpenCodeRuntimeCommand,
  publishOpenCodeRuntimeReferenceCommand
} from './ssh-relay-opencode-runtime-commands'

const SETUP_TIMEOUT_MS = 180_000
export type RemoteOpenCodeRuntimeOutcome =
  | 'ready'
  | 'not-needed'
  | 'failed'
  | 'teardown-unconfirmed'
const installations = new WeakMap<
  SshConnection,
  { generation: number; byDirectory: Map<string, Promise<RemoteOpenCodeRuntimeOutcome>> }
>()
const downloads = new Map<string, Promise<string>>()

type SetupOptions = {
  nodePath: string
  relayDir: string
  signal?: AbortSignal
  cacheRoot?: string
}
type RemoteOperation = <T>(operation: () => Promise<T>) => Promise<T>

/** Optional companion setup; the host's relay and terminals never depend on it. */
export function ensureRemoteOpenCodeRuntime(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: SetupOptions
): Promise<RemoteOpenCodeRuntimeOutcome> {
  const generation = conn.getConnectGeneration()
  let current = installations.get(conn)
  if (current?.generation !== generation) {
    current = { generation, byDirectory: new Map() }
    installations.set(conn, current)
  }
  const { byDirectory } = current
  const active = byDirectory.get(options.relayDir)
  if (active) {
    return waitForPromiseWithSignal(active, options.signal).catch(() => 'teardown-unconfirmed')
  }
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('SSH SQLite runtime setup timed out.')),
    SETUP_TIMEOUT_MS
  )
  timer.unref()
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  let remotePending = false
  let remoteUnconfirmed = false
  const remote: RemoteOperation = async (operation) => {
    signal.throwIfAborted()
    if (conn.getConnectGeneration() !== generation) {
      throw new Error('SSH connection changed during SQLite runtime setup.')
    }
    remotePending = true
    try {
      return await operation()
    } catch (error) {
      remoteUnconfirmed ||= signal.aborted || isUnconfirmedSshCommandTermination(error)
      throw error
    } finally {
      remotePending = false
    }
  }
  const pending = waitForPromiseWithSignal(
    install(conn, host, remoteHome, options, signal, remote),
    signal
  )
    .catch((error: unknown) => {
      console.warn(
        '[ssh-relay] OpenCode history runtime setup did not finish:',
        error instanceof Error ? error.message : String(error)
      )
      return remotePending || remoteUnconfirmed || isUnconfirmedSshCommandTermination(error)
        ? ('teardown-unconfirmed' as const)
        : ('failed' as const)
    })
    .then((outcome) => {
      clearTimeout(timer)
      // An unresolved channel must not admit another installer on this connection.
      if (outcome !== 'teardown-unconfirmed') {
        byDirectory.delete(options.relayDir)
      }
      return outcome
    })
  byDirectory.set(options.relayDir, pending)
  return pending
}

async function install(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: SetupOptions,
  signal: AbortSignal,
  remote: RemoteOperation
): Promise<RemoteOpenCodeRuntimeOutcome> {
  const exec = async (command: string): Promise<string> => {
    signal.throwIfAborted()
    const output = await remote(() =>
      execCommand(conn, command, {
        signal,
        wrapCommand: !isWindowsRemoteHost(host)
      })
    )
    signal.throwIfAborted()
    return output
  }
  const node = parseOpenCodeRuntimeResult(
    await exec(probeOpenCodeNodeSqliteCommand(host, options.nodePath, remoteHome))
  )
  if (node.status === 'not-needed') {
    return 'not-needed'
  }
  if (node.status !== 'ready' && node.status !== 'unsupported') {
    throw new Error('The host did not complete its SQLite read probe.')
  }
  let executable = node.executable
  let target: OrcadBunTarget | undefined
  let localRuntime: string | undefined
  if (node.status === 'unsupported') {
    target = await resolveOrcadDeploymentTarget({ conn, host, signal, exec })
    const expectedHash = ORCAD_BUN_RELEASE_ASSETS[target].executableSha256
    executable = joinRemotePath(
      host,
      remoteHome,
      RELAY_REMOTE_DIR,
      'vault-sqlite',
      expectedHash,
      isWindowsRemoteHost(host) ? 'bun.exe' : 'bun'
    )
    const cached = parseOpenCodeRuntimeResult(
      await exec(
        probeOpenCodeRuntimeCacheCommand({
          host,
          nodePath: options.nodePath,
          executable,
          expectedHash,
          reference: joinRemotePath(host, options.relayDir, 'opencode-sqlite-runtime.json')
        })
      )
    )
    if (cached.status === 'ready' && cached.executable) {
      executable = cached.executable
    } else if (cached.status === 'missing') {
      const cacheRoot =
        options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
      localRuntime = await cachedRuntime(target, cacheRoot, signal)
      signal.throwIfAborted()
    } else {
      throw new Error('The host did not confirm its SQLite runtime cache.')
    }
  }
  if (!executable) {
    throw new Error('The host did not identify its SQLite executable.')
  }
  const token = randomBytes(12).toString('hex')
  const relativePool = `${RELAY_REMOTE_DIR}/${RELAY_UPLOAD_STAGE_POOL_NAME}`
  const poolDir = joinRemotePath(host, remoteHome, relativePool)
  const owner = createRelayInstallMarkerFileName()
  await exec(recoverOneStaleRelayUploadStageCommand(host, poolDir))
  const stage = parseReservedRelayUploadStage(
    host,
    poolDir,
    owner,
    await exec(reserveRelayUploadStageCommand(host, poolDir, owner))
  )
  const stageDir = stage.slotDir
  const namespace = createRelayUploadStageNamespace(`${relativePool}/${stage.slotName}`, owner)
  const mapping = (file?: string) =>
    !isWindowsRemoteHost(host) && conn.usesSystemSshTransport?.() !== true
      ? relayUploadStageSftpNamespaceMapping(namespace, host, stageDir, file)
      : undefined
  let cleanupAllowed = true
  try {
    if (target && localRuntime) {
      const localStage = await mkdtemp(join(dirname(localRuntime), '.vault-upload-'))
      try {
        const binaryName = isWindowsRemoteHost(host) ? 'bun.exe' : 'bun'
        const localBinary = join(localStage, binaryName)
        await link(localRuntime, localBinary).catch(() => copyFile(localRuntime, localBinary))
        signal.throwIfAborted()
        await remote(() =>
          uploadRelayDirectory(conn, localStage, joinRemotePath(host, stageDir, 'payload'), host, {
            signal,
            sftpNamespace: mapping()
          })
        )
        const promoted = parseOpenCodeRuntimeResult(
          await exec(
            promoteOpenCodeRuntimeCommand({
              host,
              nodePath: options.nodePath,
              stagedBinary: joinRemotePath(host, stageDir, 'payload', binaryName),
              executable,
              expectedHash: ORCAD_BUN_RELEASE_ASSETS[target].executableSha256,
              repairToken: token
            })
          )
        )
        if (promoted.status !== 'ready' || !promoted.executable) {
          throw new Error('The host did not verify the uploaded SQLite runtime.')
        }
        executable = promoted.executable
      } finally {
        await rm(localStage, { recursive: true, force: true }).catch(() => {})
      }
    }
    const referenceName = 'opencode-sqlite-runtime.json'
    const stagedReference = joinRemotePath(host, stageDir, 'payload', referenceName)
    signal.throwIfAborted()
    await remote(() =>
      writeRelayFile(conn, host, stagedReference, JSON.stringify({ protocol: 1, executable }), {
        signal,
        sftpNamespace: mapping(referenceName)
      })
    )
    const published = parseOpenCodeRuntimeResult(
      await exec(
        publishOpenCodeRuntimeReferenceCommand({
          host,
          nodePath: options.nodePath,
          stagedReference,
          reference: joinRemotePath(host, options.relayDir, referenceName),
          token
        })
      )
    )
    return published.status === 'published' ? 'ready' : 'failed'
  } catch (error) {
    cleanupAllowed = !isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (cleanupAllowed && !signal.aborted) {
      await exec(cleanupOwnedRelayUploadStageCommand(host, stage, owner)).catch((error) => {
        if (isUnconfirmedSshCommandTermination(error)) {
          throw error
        }
      })
    }
  }
}

function cachedRuntime(
  target: OrcadBunTarget,
  cacheRoot: string,
  signal: AbortSignal
): Promise<string> {
  const key = `${cacheRoot}\0${target}`
  let pending = downloads.get(key)
  if (!pending) {
    pending = materializeCachedOrcadBunRuntime(target, cacheRoot, {
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS)
    }).finally(() => downloads.delete(key))
    downloads.set(key, pending)
  }
  return waitForPromiseWithSignal(pending, signal)
}
