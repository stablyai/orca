import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { WorkflowDefinition } from '@shared/workflow-types'

// Real values match workflow.proto:67/162 — deliberately NOT reusing WorkflowScope
// (that's a different concept: a WorkflowDefinition's own local scope, which has
// 'project' instead of 'team').
export type LibraryScope = 'company' | 'team' | 'personal'

export function useWorkflowLibrary(scope: LibraryScope, search: string) {
  const [templates, setTemplates] = useState<WorkflowDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      const result = await callRuntimeRpc<{ templates: WorkflowDefinition[] }>(
        target,
        'workflow.template.list',
        { scope }
      )
      // workflow.template.list has no server-side search yet (BE-SOL-005's
      // SearchTemplates is still Proposed) — filter client-side on the loaded
      // scope for now; upgrading to server-side search only changes this body.
      const filtered = search.trim()
        ? result.templates.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()))
        : result.templates
      setTemplates(filtered)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [scope, search])

  useEffect(() => {
    void load()
  }, [load])

  return { templates, loading, loadError, reload: load }
}
