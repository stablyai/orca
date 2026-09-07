import { useEffect, useState } from 'react'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { deriveWorkspaceSshGate, type WorkspaceSshGate } from '../tasks/workspace-ssh-gate'

type DetectedAgentIdsState = {
  connectionId: string | null
  ids: Set<string>
}

function fallbackSshState(
  targetId: string,
  status: SshConnectionState['status'],
  error: string | null
): SshConnectionState {
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
  const [sshState, setSshState] = useState<SshConnectionState | null>(null)
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
    void client
      .sendRequest('ssh.getState', { targetId: connectionId })
      .then((response) => {
        if (stale) {
          return
        }
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        const state = (response as RpcSuccess).result as { state?: SshConnectionState | null }
        setSshState(state.state ?? fallbackSshState(connectionId, 'disconnected', null))
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
        const response = connectionId
          ? await client.sendRequest('preflight.detectRemoteAgents', { connectionId })
          : await client.sendRequest('preflight.detectAgents')
        if (!stale) {
          setDetectedAgentIdsState({
            connectionId,
            ids: response.ok ? new Set((response as RpcSuccess).result as string[]) : new Set()
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
      const response = await client.sendRequest(
        'ssh.connect',
        { targetId: connectionId },
        { timeoutMs: 120_000 }
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = (response as RpcSuccess).result as { state?: SshConnectionState | null }
      setSshState(result.state ?? fallbackSshState(connectionId, 'connected', null))
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
