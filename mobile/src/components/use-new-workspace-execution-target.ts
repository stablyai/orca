import { useEffect, useState } from 'react'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import { deriveWorkspaceSshGate, type WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'

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
  operations: HostWorkspaceCreationOperations | null
  connectionId: string | null
  visible: boolean
}): {
  sshGate: WorkspaceSshGate
  detectedAgentIds: Set<string> | null
  connect: () => Promise<void>
} {
  const { operations, connectionId, visible } = args
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
    if (!visible || !operations || !connectionId) {
      return
    }
    let stale = false
    void operations
      .readSshState(connectionId)
      .then((state) => {
        if (!stale) {
          setSshState(state)
        }
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
  }, [operations, connectionId, visible])

  useEffect(() => {
    if (!visible || !operations || (connectionId && sshGate.status !== 'connected')) {
      return
    }
    let stale = false
    void (async () => {
      try {
        const agentIds = await operations.detectAgents(connectionId)
        if (!stale) {
          setDetectedAgentIdsState({
            connectionId,
            ids: new Set(agentIds)
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
  }, [operations, connectionId, sshGate.status, visible])

  async function connect(): Promise<void> {
    if (!operations || !connectionId) {
      return
    }
    setConnectingTargetId(connectionId)
    setSshState(fallbackSshState(connectionId, 'connecting', null))
    try {
      setSshState(await operations.connectSsh(connectionId))
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
