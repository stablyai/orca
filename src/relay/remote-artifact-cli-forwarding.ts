import type { RemoteArtifactInput } from '../shared/artifact-cli-bridge'
import { DISPATCHER_CONTROL_QUEUE_MAX_BYTES } from './dispatcher-writer-admission'
import { encodeJsonRpcFrame } from './protocol'

export type RemoteArtifactCliForwardingParams = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
  artifactInput?: RemoteArtifactInput
}

// Why: the daemon assigns the forwarded request id, so size against its widest safe integer.
const FORWARDED_REQUEST_SIZE_ID = Number.MAX_SAFE_INTEGER

export function remoteArtifactCliForwardingFrameBytes(
  params: RemoteArtifactCliForwardingParams
): number {
  return encodeJsonRpcFrame(
    {
      jsonrpc: '2.0',
      id: FORWARDED_REQUEST_SIZE_ID,
      method: 'orca.cli',
      params
    },
    0,
    0
  ).length
}

export function assertRemoteArtifactCliForwardingFits(
  params: RemoteArtifactCliForwardingParams
): void {
  if (remoteArtifactCliForwardingFrameBytes(params) > DISPATCHER_CONTROL_QUEUE_MAX_BYTES) {
    throw new Error(
      'Artifact is too large for the Orca SSH transport. Use the browser upload page instead.'
    )
  }
}
