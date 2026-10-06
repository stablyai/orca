import { randomBytes } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { SshConnection } from './ssh-connection'
import type { RemoteRuntimeStep } from './orcad-remote-node-runtime'
import { preparePinnedNodeForVault } from './ssh-relay-opencode-pinned-node'
import { RUNTIME_REF_NODE_PREFIX } from './remote-node-runtime-store-inventory'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { writeRelayFile } from './ssh-relay-install-transfers'
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
  probeOpenCodeNodeSqliteCommand,
  publishOpenCodeRuntimeReferenceCommand
} from './ssh-relay-opencode-runtime-commands'

const SETUP_TIMEOUT_MS = 180_000
const RUNTIME_REFERENCE_NAME = 'opencode-sqlite-runtime.json'
export type RemoteOpenCodeRuntimeOutcome =
  | 'ready'
  | 'not-needed'
  | 'failed'
  | 'teardown-unconfirmed'
const installations = new WeakMap<
  SshConnection,
  { generation: number; byDirectory: Map<string, Promise<RemoteOpenCodeRuntimeOutcome>> }
>()

type SetupOptions = {
  nodePath: string
  /** The relay's verified pinned node.exe, if any; stage fencing then needs no Add-Type (D5). */
  verifiedNodePath?: string
  relayDir: string
  signal?: AbortSignal
  cacheRoot?: string
}

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
  const assertCurrentGeneration = (): void => {
    if (conn.getConnectGeneration() !== generation) {
      throw new Error('SSH connection changed during SQLite runtime setup.')
    }
  }
  const remote: RemoteRuntimeStep = async (operation) => {
    signal.throwIfAborted()
    assertCurrentGeneration()
    remotePending = true
    try {
      const result = await operation()
      assertCurrentGeneration()
      return result
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
    .then((outcome) => {
      assertCurrentGeneration()
      return outcome
    })
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
  remote: RemoteRuntimeStep
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
  let runtimeRef: { path: string; sha256: string } | undefined
  let identityNode = options.verifiedNodePath
  if (node.status === 'unsupported') {
    const pinned = await preparePinnedNodeForVault({
      conn,
      host,
      relayDir: options.relayDir,
      cacheRoot: options.cacheRoot,
      signal,
      exec,
      remote
    })
    executable = pinned.executable
    identityNode ??= pinned.executable
    runtimeRef = {
      path: joinRemotePath(
        host,
        options.relayDir,
        `${RUNTIME_REF_NODE_PREFIX}${pinned.runtimeSha256}`
      ),
      sha256: pinned.runtimeSha256
    }
  }
  if (!executable) {
    throw new Error('The host did not identify its SQLite executable.')
  }
  const token = randomBytes(12).toString('hex')
  const relativePool = `${RELAY_REMOTE_DIR}/${RELAY_UPLOAD_STAGE_POOL_NAME}`
  const poolDir = joinRemotePath(host, remoteHome, relativePool)
  const owner = createRelayInstallMarkerFileName()
  const identity = identityNode ? { node: identityNode } : undefined
  await exec(recoverOneStaleRelayUploadStageCommand(host, poolDir, undefined, identity))
  const stage = parseReservedRelayUploadStage(
    host,
    poolDir,
    owner,
    await exec(reserveRelayUploadStageCommand(host, poolDir, owner, identity))
  )
  const stageDir = stage.slotDir
  const namespace = createRelayUploadStageNamespace(`${relativePool}/${stage.slotName}`, owner)
  const mapping = (file?: string) =>
    !isWindowsRemoteHost(host) && conn.usesSystemSshTransport?.() !== true
      ? relayUploadStageSftpNamespaceMapping(namespace, host, stageDir, file)
      : undefined
  let cleanupAllowed = true
  try {
    const referenceName = RUNTIME_REFERENCE_NAME
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
          token,
          runtimeRef
        })
      )
    )
    return published.status === 'published' ? 'ready' : 'failed'
  } catch (error) {
    cleanupAllowed = !isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (cleanupAllowed && !signal.aborted) {
      await exec(cleanupOwnedRelayUploadStageCommand(host, stage, owner, identity)).catch(
        (error) => {
          if (isUnconfirmedSshCommandTermination(error)) {
            throw error
          }
        }
      )
    }
  }
}
