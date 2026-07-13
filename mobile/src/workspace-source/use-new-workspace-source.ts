import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type {
  ResolvedNewWorkspaceSource,
  WorkspaceSourceAvailability
} from './new-workspace-source-types'
import {
  getWorkspaceSourceAvailability,
  hasWorkspaceSourceAvailability
} from './workspace-source-availability'
import {
  applyManualWorkspaceName,
  applySourceWorkspaceName,
  clearSourceWorkspaceName,
  createWorkspaceNameState,
  type WorkspaceNameState
} from './workspace-source-name-state'

type SourceRepo = {
  id: string
  displayName: string
  kind?: 'git' | 'folder'
}

export type NewWorkspaceSourceController = {
  name: WorkspaceNameState
  source: ResolvedNewWorkspaceSource | null
  availability: WorkspaceSourceAvailability
  sshStateGeneration: number
  fieldVisible: boolean
  drawerVisible: boolean
  setDrawerVisible: (visible: boolean) => void
  setManualName: (value: string) => void
  selectSource: (source: ResolvedNewWorkspaceSource) => void
  clearSource: () => void
  setReuseEnabled: (enabled: boolean) => void
  refreshLinearStatus: () => void
}

export function useNewWorkspaceSource(args: {
  visible: boolean
  client: RpcClient | null
  capabilities: readonly string[] | null | undefined
  repo: SourceRepo | null
  repoConnected: boolean
  sshStateGeneration: number
}): NewWorkspaceSourceController {
  const [name, setName] = useState(() => createWorkspaceNameState())
  const [source, setSource] = useState<ResolvedNewWorkspaceSource | null>(null)
  const [linearConnected, setLinearConnected] = useState(false)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const linearGenerationRef = useRef(0)
  const previousRepoIdRef = useRef<string | null>(null)
  const previousSshGenerationRef = useRef(args.sshStateGeneration)

  const refreshLinearStatus = useCallback(() => {
    const generation = ++linearGenerationRef.current
    if (!args.visible || !args.client) {
      setLinearConnected(false)
      return
    }
    void args.client
      .sendRequest('linear.status')
      .then((response) => {
        if (generation !== linearGenerationRef.current) {
          return
        }
        const result = response.ok
          ? ((response as RpcSuccess).result as { connected?: unknown })
          : null
        setLinearConnected(result?.connected === true)
      })
      .catch(() => {
        if (generation === linearGenerationRef.current) {
          setLinearConnected(false)
        }
      })
  }, [args.client, args.visible])

  useEffect(() => {
    refreshLinearStatus()
  }, [refreshLinearStatus])

  useEffect(() => {
    const previousRepoId = previousRepoIdRef.current
    previousRepoIdRef.current = args.repo?.id ?? null
    if (!previousRepoId || previousRepoId === args.repo?.id) {
      return
    }
    if (source && source.kind !== 'linear') {
      setName(clearSourceWorkspaceName)
      setSource(null)
    }
    setDrawerVisible(false)
  }, [args.repo?.id, source])

  useEffect(() => {
    if (previousSshGenerationRef.current === args.sshStateGeneration) {
      return
    }
    previousSshGenerationRef.current = args.sshStateGeneration
    if (source && source.kind !== 'linear') {
      setName(clearSourceWorkspaceName)
      setSource(null)
    }
  }, [args.sshStateGeneration, source])

  const availability = useMemo(
    () =>
      getWorkspaceSourceAvailability({
        capabilities: args.capabilities,
        repoKind: args.repo?.kind,
        repoConnected: args.repoConnected,
        linearConnected
      }),
    [args.capabilities, args.repo?.kind, args.repoConnected, linearConnected]
  )
  const effectiveSource =
    source &&
    (source.kind === 'github'
      ? availability.github
      : source.kind === 'branch'
        ? availability.branches
        : availability.linear)
      ? source
      : null

  useEffect(() => {
    if (!source || effectiveSource) {
      return
    }
    // Why: a hidden source must not leak into Create, while a manual name remains user-owned.
    setName(clearSourceWorkspaceName)
    setSource(null)
    setDrawerVisible(false)
  }, [effectiveSource, source])

  const selectSource = useCallback((next: ResolvedNewWorkspaceSource) => {
    setSource(next)
    setName((current) => {
      const suggestion =
        next.kind === 'github' || next.kind === 'linear' ? next.suggestedName : next.branchAutoName
      return applySourceWorkspaceName(current, suggestion).state
    })
    setDrawerVisible(false)
  }, [])

  return {
    name,
    source: effectiveSource,
    availability,
    sshStateGeneration: args.sshStateGeneration,
    fieldVisible: Boolean(args.repo) && hasWorkspaceSourceAvailability(availability),
    drawerVisible,
    setDrawerVisible,
    setManualName: (value) => setName((current) => applyManualWorkspaceName(current, value)),
    selectSource,
    clearSource: () => {
      setSource(null)
      setName(clearSourceWorkspaceName)
    },
    setReuseEnabled: (enabled) =>
      setSource((current) =>
        current?.kind === 'branch' && current.reuseEligibleBranch
          ? { ...current, reuseEnabled: enabled }
          : current
      ),
    refreshLinearStatus
  }
}
