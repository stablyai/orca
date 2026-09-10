import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceCanvasDocument } from '../../../src/shared/maestro-document-contract'
import { WorkspaceCanvasDocumentSchema } from '../../../src/shared/maestro-document-contract'
import type {
  RuntimeMaestroWorkspaceCanvasMutation,
  RuntimeMaestroWorkspaceCanvasMutationResult,
  RuntimeMaestroWorkspaceCanvasQueryResult,
  RuntimeMaestroWorkspaceContentReadResult
} from '../../../src/shared/runtime-types'
import {
  WorkspaceSurfaceSnapshotSchema,
  type WorkspaceSurfaceSnapshot
} from '../../../src/shared/maestro-workspace-canvas'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import {
  parseLegacyMobileMaestroRunProgress,
  parseMobileMaestroRunProgressRpcResult,
  type MobileMaestroRunProgress
} from './mobile-maestro-run-progress'

export const MAESTRO_WORKSPACE_CANVAS_CAPABILITY = 'maestro.workspace-canvas.v1'

export type MobileMaestroScope = {
  execution_host_id: string
  workspace_key: string
}

export type MobileMaestroAvailable = {
  actorId: string
  snapshot: WorkspaceSurfaceSnapshot
  canvas: { revision: number; document: WorkspaceCanvasDocument; updatedAt: string | null }
  runProgress: MobileMaestroRunProgress | null
}

export type MobileMaestroLoadState =
  | { status: 'loading' }
  | { status: 'available'; value: MobileMaestroAvailable }
  | { status: 'unavailable'; reason: string; lastKnown?: WorkspaceSurfaceSnapshot }
  | { status: 'error'; reason: string }

export type MobileMaestroMutationAction =
  | { action: 'create'; surface_type: 'terminal' | 'browser'; title?: string }
  | {
      action: 'create'
      surface_type: 'content'
      title?: string
      annotation: { text: string; tone: 'decision' | 'warning' | 'blocked' | 'observation' }
      expected_canvas_revision: number
    }
  | {
      action: 'focus' | 'close'
      surface_id: WorkspaceSurfaceSnapshot['surfaces'][string]['id']
      expected_canvas_revision: number
    }
  | {
      action: 'set-viewport'
      viewport: { center: { x: number; y: number }; zoom: number }
      expected_canvas_revision: number
    }
  | {
      action: 'create-manual-link'
      source_surface_key: string
      target_surface_key: string
      link_type: string
      label: string | null
      expected_canvas_revision: number
    }
  | {
      action: 'decide-suggestion'
      fingerprint: string
      decision: 'accepted' | 'hidden'
      link_type?: string
      label?: string | null
      expected_canvas_revision: number
    }

type MaestroListResult = {
  entries: Array<{
    executionHostId: string
    workspaceKey: string
    runProgress?: unknown
  }>
}

function successResult<T>(response: Awaited<ReturnType<RpcClient['sendRequest']>>): T {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return (response as RpcSuccess).result as T
}

export function requireAppliedMobileMaestroMutation(
  result: RuntimeMaestroWorkspaceCanvasMutationResult
): RuntimeMaestroWorkspaceCanvasMutationResult {
  if (result.status === 'applied' || result.status === 'replayed') {
    return result
  }
  throw new Error(`${result.status}: ${result.reason ?? 'workspace_canvas_mutation_not_applied'}`)
}

export async function loadMobileMaestroWorkspace(
  client: RpcClient,
  scope: MobileMaestroScope
): Promise<MobileMaestroLoadState> {
  const [canvasResponse, progressResponse, listResponse] = await Promise.all([
    client.sendRequest('maestro.workspaceCanvas.get', scope),
    client.sendRequest('maestro.runProgress.get', { scope }).catch(() => null),
    client.sendRequest('maestro.list').catch(() => null)
  ])
  const result = successResult<RuntimeMaestroWorkspaceCanvasQueryResult>(canvasResponse)
  if (result.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: result.reason,
      lastKnown: result.last_known_snapshot
    }
  }
  const snapshot = WorkspaceSurfaceSnapshotSchema.parse(result.snapshot)
  const document = WorkspaceCanvasDocumentSchema.parse(result.canvas.document)
  let runProgress = progressResponse?.ok
    ? parseMobileMaestroRunProgressRpcResult(successResult<unknown>(progressResponse))
    : null
  if (!runProgress && listResponse?.ok) {
    const entries = successResult<MaestroListResult>(listResponse).entries
    const legacyProgress =
      entries.find(
        (entry) =>
          entry.executionHostId === scope.execution_host_id &&
          entry.workspaceKey === scope.workspace_key
      )?.runProgress ?? null
    runProgress = parseLegacyMobileMaestroRunProgress(legacyProgress)
  }
  return {
    status: 'available',
    value: {
      actorId: result.actor_id,
      snapshot,
      canvas: {
        revision: result.canvas.revision,
        document,
        updatedAt: result.canvas.updated_at
      },
      runProgress
    }
  }
}

export function useMobileMaestroWorkspace(
  client: RpcClient | null,
  connected: boolean,
  scope: MobileMaestroScope
) {
  const [state, setState] = useState<MobileMaestroLoadState>({ status: 'loading' })
  const requestGeneration = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const refresh = useCallback(async () => {
    if (!client || !connected) {
      return
    }
    const generation = ++requestGeneration.current
    try {
      const next = await loadMobileMaestroWorkspace(client, scope)
      if (generation === requestGeneration.current) {
        setState(next)
      }
    } catch (error) {
      if (generation === requestGeneration.current) {
        setState({
          status: 'error',
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }, [client, connected, scope.execution_host_id, scope.workspace_key])

  useEffect(() => {
    setState({ status: 'loading' })
    void refresh()
    if (!client || !connected) {
      return
    }
    const timer = setInterval(() => void refresh(), 1_500)
    return () => {
      requestGeneration.current += 1
      clearInterval(timer)
    }
  }, [client, connected, refresh])

  const mutate = useCallback(
    async (
      action: MobileMaestroMutationAction
    ): Promise<RuntimeMaestroWorkspaceCanvasMutationResult> => {
      const current = stateRef.current
      if (!client || current.status !== 'available') {
        throw new Error('workspace_canvas_unavailable')
      }
      const request = {
        ...action,
        scope,
        actor_id: current.value.actorId,
        expected_authority_revision: current.value.snapshot.authority_revision,
        ...('expected_canvas_revision' in action
          ? { expected_canvas_revision: current.value.canvas.revision }
          : {}),
        idempotency_key: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
      const response = await client.sendRequest(
        'maestro.workspaceCanvas.mutate',
        request as RuntimeMaestroWorkspaceCanvasMutation
      )
      const result = successResult<RuntimeMaestroWorkspaceCanvasMutationResult>(response)
      await refresh()
      return requireAppliedMobileMaestroMutation(result)
    },
    [client, refresh, scope]
  )

  const readContent = useCallback(
    async (surfaceId: WorkspaceSurfaceSnapshot['surfaces'][string]['id']) => {
      if (!client) {
        throw new Error('workspace_canvas_unavailable')
      }
      const response = await client.sendRequest('maestro.workspaceCanvas.readContent', {
        scope,
        surface_id: surfaceId
      })
      return successResult<RuntimeMaestroWorkspaceContentReadResult>(response)
    },
    [client, scope]
  )

  return { state, refresh, mutate, readContent }
}
