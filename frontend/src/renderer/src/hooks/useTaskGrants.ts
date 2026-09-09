import { useState, useCallback } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { toast } from 'sonner'
import type { RealGrantLevel } from '../../../shared/task-types'

export function useTaskGrants(taskId: string) {
  const [isGranting, setIsGranting] = useState(false)

  const addGrant = useCallback(
    async (subjectId: string, level: RealGrantLevel, applyTree: boolean) => {
      setIsGranting(true)
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      try {
        // Shape from channels_automation_task.go:369-388 — level is a string
        // ('owner'|'admin'|'user'|'team'|'company'), parsed server-side via taskv1.GrantLevel_value.
        await callRuntimeRpc(target, 'task.grant', { taskId, subjectId, level, applyTree })
        toast.success(`Granted ${level} to ${subjectId}`)
      } catch (err) {
        toast.error(`Failed to grant: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      } finally {
        setIsGranting(false)
      }
    },
    [taskId]
  )

  // task.listGrants does not exist yet (BE-SOL-003 still Proposed) — return empty rather
  // than faking data, so the UI doesn't imply this is already wired up.
  const grants: { subjectId: string; level: RealGrantLevel }[] = []

  // revoke/generateShareLink have no RPC yet — no-op with a clear toast, never fail silently.
  const revoke = useCallback((_subjectId: string) => {
    toast.info('Revoke grant is not available yet (pending BE-SOL-003)')
  }, [])
  const generateShareLink = useCallback(() => {
    toast.info('Share link is not available yet (pending BE-SOL-003)')
  }, [])

  return { grants, addGrant, revoke, generateShareLink, isGranting }
}
