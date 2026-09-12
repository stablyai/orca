import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyOwnershipTransferOutputEnvelope } from '../../shared/pty-ownership-transfer-output-envelope'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-ownership-transfer-output-assembler'

export type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  /** Executable used to launch relay.js (Bun in strict mode, Node for legacy hosts). */
  runtimePath?: string
  /** Runtime identity carried with the path so Bun is never mislabeled as Node. */
  runtimeKind?: 'node' | 'bun'
  /** @deprecated Kept for mixed-version callers; use runtimePath/runtimeKind. */
  nodePath?: string
  sockPath: string
  credentialFile?: string
  pathDelimiter?: ':' | ';'
}

/** Resolve the runtime while keeping legacy Node-only bridge payloads readable. */
export function resolveRemoteCliRuntime(env: RemoteCliBridgeEnv): {
  path: string
  kind: 'node' | 'bun'
} {
  const path = env.runtimePath ?? env.nodePath
  if (!path) {
    throw new Error('Remote CLI bridge runtime path is missing')
  }
  const kind = env.runtimeKind ?? (env.runtimePath && !env.nodePath ? 'bun' : 'node')
  return { path, kind }
}

export type SshPtyDataCallback = (payload: {
  id: string
  data: string
  providerGeneration: number
  ptyIncarnation: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
  source?: Readonly<{
    relayPtyId: string
    spanId: string
    clientGeneration: number
    ownerGeneration: number
    deliveryToken: string
    sourceStartSu: number
    sourceEndSu: number
    ownershipTransfer?: PtyOwnershipTransferOutputEnvelope
  }>
  sourceMalformed?: boolean
  sourceRejected?: boolean
  rejectedSourceRecovery?: 'confirm-existing' | 'fresh-activation' | 'reconnect-channel'
}) => void

/** Destination ownership-transfer delivery may wait for the normal model checkpoint. */
export type SshPtyOwnershipTransferOutputCallback = (
  identity: PtyOwnershipTransferWireIdentity,
  frame: PtyOwnershipTransferOutputFrame,
  sourceRanges: readonly SshPtyOwnershipTransferSourceRange[]
) => void | Promise<void>

export type SshPtyReplayCallback = (payload: { id: string; data: string }) => void
export type SshPtyExitCallback = (payload: {
  id: string
  code: number
  providerGeneration: number
  ptyIncarnation: string
  incarnationId?: PtyIncarnationId
}) => void

export type SshPtyDeliveryPauseAdapter = (args: {
  id: string
  providerGeneration: number
  paused: boolean
}) => void

export type SshPtyOwnershipTransferOwner = Readonly<{
  ownerLease: string
  sourceOwnerGeneration: number
}>
