import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import {
  isCloudWorkspaceGoneFromRegistry,
  listCloudWorkspaces,
  readCloudWorkspaceStatus,
  type CloudWorkspace
} from './cloud-control-plane-client'
import {
  loadCloudDeviceIdentity,
  subscribeCloudDeviceIdentity,
  type CloudEnrollment
} from './cloud-device-identity'
import { pruneCloudHostsMissingFrom } from './cloud-host-pruning'
import {
  cloudHostRemover,
  forgetRevokedCloudSession,
  loadCloudControlPlane,
  useCloudHostRemoval
} from './cloud-session'

const TRANSITIONAL: ReadonlySet<CloudWorkspace['status']> = new Set([
  'creating',
  'waking',
  'stopping'
])

export const cloudWorkspacesQueryKey = (sessionId: string | null) =>
  ['orca-cloud', 'workspaces', sessionId] as const

/** True while this screen is on top; Home stays mounted under every pushed screen. */
function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  return focused
}

/** This phone's Orca Cloud enrollment; `undefined` while the keychain read is in flight. */
export function useCloudEnrollment(): CloudEnrollment | null | undefined {
  const [enrollment, setEnrollment] = useState<CloudEnrollment | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const load = () =>
      void loadCloudDeviceIdentity()
        .then((identity) => live && setEnrollment(identity.enrollment))
        .catch(() => live && setEnrollment(null))
    load()
    const unsubscribe = subscribeCloudDeviceIdentity(load)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  return enrollment
}

export function useCloudWorkspaces(enrollment: CloudEnrollment | null | undefined) {
  const sessionId = enrollment?.deviceSessionId ?? null
  const removal = useCloudHostRemoval()
  const focused = useScreenFocused()
  return useQuery({
    queryKey: cloudWorkspacesQueryKey(sessionId),
    enabled: sessionId !== null,
    queryFn: async ({ signal }) => {
      const plane = await loadCloudControlPlane()
      if (!plane) {
        return []
      }
      try {
        const startedAt = Date.now()
        const list = await listCloudWorkspaces(plane, signal)
        if (list.complete) {
          // A linked workspace the list lacks is checked by id; one the registry says is gone
          // (destroyed, or no longer shared) stops being retried.
          void pruneCloudHostsMissingFrom(
            new Set(list.workspaces.map((workspace) => workspace.id)),
            startedAt,
            (sandboxId) => isCloudWorkspaceGoneFromRegistry(plane, sandboxId),
            cloudHostRemover(removal)
          ).catch(() => undefined)
        }
        return list.workspaces
      } catch (error) {
        await forgetRevokedCloudSession(error, removal)
        throw error
      }
    },
    // Fast while something changes state, slow otherwise, never while another screen is on top.
    refetchInterval: (query) =>
      !focused
        ? false
        : query.state.data?.some((workspace) => TRANSITIONAL.has(workspace.status))
          ? 3_000
          : 20_000,
    staleTime: 2_000
  })
}

export function useCloudWorkspace(
  enrollment: CloudEnrollment | null | undefined,
  sandboxId: string
) {
  const list = useCloudWorkspaces(enrollment)
  return { ...list, workspace: list.data?.find((entry) => entry.id === sandboxId) ?? null }
}

/** Live uptime and spend for one workspace while its screen is open. */
export function useCloudWorkspaceLiveStatus(sandboxId: string, enabled: boolean) {
  const focused = useScreenFocused()
  const removal = useCloudHostRemoval()
  return useQuery({
    queryKey: ['orca-cloud', 'status', sandboxId],
    enabled,
    queryFn: async () => {
      const plane = await loadCloudControlPlane()
      try {
        return plane ? await readCloudWorkspaceStatus(plane, sandboxId) : null
      } catch (error) {
        await forgetRevokedCloudSession(error, removal)
        throw error
      }
    },
    refetchInterval: focused ? 15_000 : false,
    retry: false
  })
}

export function useInvalidateCloudWorkspaces(): () => void {
  const client = useQueryClient()
  return useCallback(() => void client.invalidateQueries({ queryKey: ['orca-cloud'] }), [client])
}

/** Puts a just-created workspace in the list so its screen never flashes "gone". */
export function useSeedCloudWorkspace(): (sessionId: string, workspace: CloudWorkspace) => void {
  const client = useQueryClient()
  return useCallback(
    (sessionId, workspace) =>
      client.setQueryData<CloudWorkspace[]>(cloudWorkspacesQueryKey(sessionId), (current) => [
        ...(current ?? []).filter((entry) => entry.id !== workspace.id),
        workspace
      ]),
    [client]
  )
}
