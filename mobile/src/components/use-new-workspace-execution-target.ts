import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  localAgentDetectionRead,
  remoteAgentDetectionRead,
  sshRepoConnectRun,
  sshRepoStateRead
} from '../tasks/mobile-workspace-source-operations'
import {
  deriveWorkspaceSshGate,
  type WorkspaceSshGate,
  type WorkspaceSshRecord
} from '../tasks/workspace-ssh-gate'

type DetectedAgentIdsState = {
  connectionId: string | null
  ids: Set<string>
}

function fallbackSshState(
  targetId: string,
  status: WorkspaceSshRecord['status'],
  error: string | null
): WorkspaceSshRecord {
  return { targetId, status, error, reconnectAttempt: 0 }
}

export function useNewWorkspaceExecutionTarget(args: {
  client: RpcClient | null
  connectionId: string | null
  visible: boolean
}): {
  sshGate: WorkspaceSshGate
  detectedAgentIds: Set<string> | null
  connect: () => Promise<void>
} {
  const { client, connectionId, visible } = args
  const [sshState, setSshState] = useState<WorkspaceSshRecord | null>(null)
  const [connectingTargetId, setConnectingTargetId] = useState<string | null>(null)
  const [detectedAgentIdsState, setDetectedAgentIdsState] = useState<DetectedAgentIdsState | null>(
    null
  )
  const sshGate = deriveWorkspaceSshGate({
    connectionId,
    state: sshState,
    connecting: connectingTargetId === connectionId
  })
  const detectedAgentIds =
    detectedAgentIdsState?.connectionId === connectionId &&
    (connectionId === null || sshGate.status === 'connected')
      ? detectedAgentIdsState.ids
      : null

  useEffect(() => {
    if (!visible || !client || !connectionId) {
      return
    }
    let stale = false
    void sshRepoStateRead
      .request(client, { targetId: connectionId })
      .then((reply) => {
        if (stale) {
          return
        }
        const state = sshRepoStateRead.interpret(reply)
        setSshState(state ?? fallbackSshState(connectionId, 'disconnected', null))
      })
      .catch((error) => {
        if (!stale) {
          setSshState(
            fallbackSshState(
              connectionId,
              'error',
              error instanceof Error ? error.message : 'Failed to read SSH connection state.'
            )
          )
        }
      })
    return () => {
      stale = true
    }
  }, [client, connectionId, visible])

  useEffect(() => {
    if (!visible || !client || (connectionId && sshGate.status !== 'connected')) {
      return
    }
    let stale = false
    void (async () => {
      try {
        const detected = connectionId
          ? remoteAgentDetectionRead.interpret(
              await remoteAgentDetectionRead.request(client, { connectionId })
            )
          : localAgentDetectionRead.interpret(await localAgentDetectionRead.request(client))
        if (!stale) {
          setDetectedAgentIdsState({
            connectionId,
            ids: detected.accepted ? new Set(detected.value) : new Set()
          })
        }
      } catch {
        if (!stale) {
          setDetectedAgentIdsState({ connectionId, ids: new Set() })
        }
      }
    })()
    return () => {
      stale = true
    }
  }, [client, connectionId, sshGate.status, visible])

  async function connect(): Promise<void> {
    if (!client || !connectionId) {
      return
    }
    setConnectingTargetId(connectionId)
    setSshState(fallbackSshState(connectionId, 'connecting', null))
    try {
      const reply = await sshRepoConnectRun.request(
        client,
        { targetId: connectionId },
        { timeoutMs: 120_000 }
      )
      const state = sshRepoConnectRun.interpret(reply)
      setSshState(state ?? fallbackSshState(connectionId, 'connected', null))
    } catch (error) {
      setSshState(
        fallbackSshState(
          connectionId,
          'error',
          error instanceof Error ? error.message : 'Failed to connect to SSH repository.'
        )
      )
    } finally {
      setConnectingTargetId((current) => (current === connectionId ? null : current))
    }
  }

  return { sshGate, detectedAgentIds, connect }
}
