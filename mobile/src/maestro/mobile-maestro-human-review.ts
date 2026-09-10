import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  MaestroHumanReviewSchema,
  type MaestroHumanReview,
  type MaestroHumanReviewTransitionRequest
} from '../../../src/shared/maestro-human-review'
import { MaestroBrowserSurfaceReceiptSchema } from '../../../src/shared/maestro-browser-surface'
import type { MaestroWorkspaceAnchor } from '../../../src/shared/maestro-contract'
import type {
  WorkspaceSurface,
  WorkspaceSurfaceSnapshot
} from '../../../src/shared/maestro-workspace-canvas'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileMaestroScope } from './mobile-maestro-workspace'

const REVIEW_POLL_INTERVAL_MS = 1_500

const ProjectionAuthoritySchema = z
  .object({
    repositoryId: z.string().min(1),
    runId: z.string().min(1),
    coordinator: z.object({ generation: z.number().int().min(1) }).passthrough(),
    workspace: z
      .object({ executionHostId: z.string().min(1), workspaceKey: z.string().min(1) })
      .passthrough(),
    nodes: z.array(
      z.object({ browserSurface: MaestroBrowserSurfaceReceiptSchema.optional() }).passthrough()
    )
  })
  .passthrough()

const HumanReviewListSchema = z.object({ reviews: z.array(MaestroHumanReviewSchema) }).strict()

type RetainedBrowserReference = {
  surfaceId: string
  browserPageId: string
}

export type MobileMaestroReviewAuthority = {
  workspace: MaestroWorkspaceAnchor
  coordinatorGeneration: number
  retainedBrowsers: readonly RetainedBrowserReference[]
}

export function buildMobileReviewBrowserFocusRequest(
  review: MaestroHumanReview,
  authority: MobileMaestroReviewAuthority
) {
  const browser = review.references.browser
  if (!browser) {
    throw new Error('This review has no Browser surface.')
  }
  return {
    schema_version: 1 as const,
    protocol: 'maestro-browser-surface/v1' as const,
    workspace: authority.workspace,
    actor: {
      actor_id: 'mobile-canvas-human',
      kind: 'user' as const,
      authenticated: true as const,
      session_id: 'mobile-canvas-human'
    },
    coordinator_generation: authority.coordinatorGeneration,
    surface_id: browser.surface_id,
    ...(browser.profile_consent_receipt
      ? { profile_consent_receipt: browser.profile_consent_receipt }
      : {})
  }
}

export type MobileMaestroHumanReviewTransitionInput =
  MaestroHumanReviewTransitionRequest extends infer Request
    ? Request extends MaestroHumanReviewTransitionRequest
      ? Omit<Request, 'workspace'>
      : never
    : never

export type MobileMaestroHumanReviewResource = {
  status: 'loading' | 'ready' | 'unavailable' | 'error'
  reviews: readonly MaestroHumanReview[]
  message: string | null
  refresh: () => Promise<void>
  transition: (request: MobileMaestroHumanReviewTransitionInput) => Promise<void>
  canFocusBrowser: (review: MaestroHumanReview, snapshot: WorkspaceSurfaceSnapshot) => boolean
  focusBrowser: (
    review: MaestroHumanReview,
    snapshot: WorkspaceSurfaceSnapshot
  ) => Promise<WorkspaceSurface>
}

type LoadedReviews =
  | { status: 'ready'; reviews: MaestroHumanReview[]; authority: MobileMaestroReviewAuthority }
  | { status: 'unavailable'; message: string }

function methodUnavailable(response: Awaited<ReturnType<RpcClient['sendRequest']>>): boolean {
  return !response.ok && response.error.code === 'method_not_found'
}

function requireResult(response: Awaited<ReturnType<RpcClient['sendRequest']>>): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

export async function loadMobileMaestroHumanReviews(
  client: RpcClient,
  scope: MobileMaestroScope
): Promise<LoadedReviews> {
  const projectionResponse = await client.sendRequest('maestro.projection.get', { scope })
  if (methodUnavailable(projectionResponse)) {
    return { status: 'unavailable', message: 'Application review requires a newer Orca host.' }
  }
  const projection = ProjectionAuthoritySchema.nullable().parse(requireResult(projectionResponse))
  if (
    !projection ||
    projection.workspace.executionHostId !== scope.execution_host_id ||
    projection.workspace.workspaceKey !== scope.workspace_key
  ) {
    return { status: 'unavailable', message: 'No authoritative Run is available for review.' }
  }
  const authority: MobileMaestroReviewAuthority = {
    workspace: {
      repository_id: projection.repositoryId,
      execution_host_id: projection.workspace.executionHostId,
      workspace_key: projection.workspace.workspaceKey,
      run_id: projection.runId
    },
    coordinatorGeneration: projection.coordinator.generation,
    retainedBrowsers: projection.nodes.flatMap((node) => {
      const browser = node.browserSurface
      return browser?.state === 'retained' && browser.browser_page_id
        ? [{ surfaceId: browser.surface_id, browserPageId: browser.browser_page_id }]
        : []
    })
  }
  const listResponse = await client.sendRequest('maestro.humanReview.list', {
    workspace: authority.workspace
  })
  if (methodUnavailable(listResponse)) {
    return { status: 'unavailable', message: 'Application review requires a newer Orca host.' }
  }
  return {
    status: 'ready',
    reviews: HumanReviewListSchema.parse(requireResult(listResponse)).reviews,
    authority
  }
}

export function resolveRetainedReviewBrowser(
  review: MaestroHumanReview,
  authority: MobileMaestroReviewAuthority,
  snapshot: WorkspaceSurfaceSnapshot
): WorkspaceSurface | null {
  const reference = review.references.browser
  if (!reference || review.workspace.run_id !== authority.workspace.run_id) {
    return null
  }
  const retained = authority.retainedBrowsers.some(
    (browser) =>
      browser.surfaceId === reference.surface_id &&
      browser.browserPageId === reference.browser_page_id
  )
  if (!retained) {
    return null
  }
  const matches = Object.values(snapshot.surfaces).filter(
    (surface) =>
      surface.binding.kind === 'browser' &&
      surface.binding.browser_page_id === reference.browser_page_id &&
      surface.id.execution_host_id === authority.workspace.execution_host_id &&
      surface.id.workspace_key === authority.workspace.workspace_key
  )
  return matches.length === 1 ? matches[0]! : null
}

export function useMobileMaestroHumanReview(
  client: RpcClient | null,
  connected: boolean,
  scope: MobileMaestroScope
): MobileMaestroHumanReviewResource {
  const identity = `${scope.execution_host_id}\0${scope.workspace_key}`
  const [state, setState] = useState<{
    identity: string
    status: MobileMaestroHumanReviewResource['status']
    reviews: readonly MaestroHumanReview[]
    message: string | null
    authority: MobileMaestroReviewAuthority | null
  }>({ identity, status: 'loading', reviews: [], message: null, authority: null })

  const refresh = useCallback(async () => {
    if (!client || !connected) {
      return
    }
    try {
      const loaded = await loadMobileMaestroHumanReviews(client, scope)
      setState({
        identity,
        status: loaded.status,
        reviews: loaded.status === 'ready' ? loaded.reviews : [],
        message: loaded.status === 'unavailable' ? loaded.message : null,
        authority: loaded.status === 'ready' ? loaded.authority : null
      })
    } catch (error) {
      setState({
        identity,
        status: 'error',
        reviews: [],
        message: error instanceof Error ? error.message : 'Application review is unavailable.',
        authority: null
      })
    }
  }, [client, connected, identity, scope])

  useEffect(() => {
    setState({ identity, status: 'loading', reviews: [], message: null, authority: null })
    void refresh()
    if (!client || !connected) {
      return
    }
    const timer = setInterval(() => void refresh(), REVIEW_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [client, connected, identity, refresh])

  const transition = useCallback(
    async (request: MobileMaestroHumanReviewTransitionInput) => {
      if (!client || state.identity !== identity || state.status !== 'ready' || !state.authority) {
        throw new Error('Application review mutation is unavailable on this host.')
      }
      const response = await client.sendRequest('maestro.humanReview.transition', {
        ...request,
        workspace: state.authority.workspace
      })
      MaestroHumanReviewSchema.parse(requireResult(response))
      await refresh()
    },
    [client, identity, refresh, state]
  )

  const focusBrowser = useCallback(
    async (review: MaestroHumanReview, snapshot: WorkspaceSurfaceSnapshot) => {
      if (!client || state.identity !== identity || state.status !== 'ready' || !state.authority) {
        throw new Error('Browser Focus is unavailable on this host.')
      }
      const surface = resolveRetainedReviewBrowser(review, state.authority, snapshot)
      if (!surface || !review.references.browser) {
        throw new Error('The exact retained Browser page is unavailable.')
      }
      const response = await client.sendRequest(
        'orchestration.browserSurface.focus',
        buildMobileReviewBrowserFocusRequest(review, state.authority)
      )
      const receipt = MaestroBrowserSurfaceReceiptSchema.parse(requireResult(response))
      if (
        receipt.state !== 'retained' ||
        receipt.surface_id !== review.references.browser.surface_id ||
        receipt.browser_page_id !== review.references.browser.browser_page_id
      ) {
        throw new Error('Browser Focus returned a different retained page.')
      }
      return surface
    },
    [client, identity, state]
  )

  const canFocusBrowser = useCallback(
    (review: MaestroHumanReview, snapshot: WorkspaceSurfaceSnapshot) =>
      state.identity === identity &&
      state.status === 'ready' &&
      state.authority !== null &&
      resolveRetainedReviewBrowser(review, state.authority, snapshot) !== null,
    [identity, state]
  )

  return useMemo(
    () =>
      state.identity === identity
        ? { ...state, refresh, transition, canFocusBrowser, focusBrowser }
        : {
            status: 'loading' as const,
            reviews: [],
            message: null,
            refresh,
            transition,
            canFocusBrowser,
            focusBrowser
          },
    [canFocusBrowser, focusBrowser, identity, refresh, state, transition]
  )
}
