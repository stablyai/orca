import { useState, useMemo, useCallback, useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { OrcaTask } from '../../../shared/task-types'

export function useTasks(projectId: string) {
  // Use Option B: flat filter since store doesn't have tasksByProject index yet.
  // Why select the raw `tasks` array here instead of filtering inside the
  // selector: `.filter()` allocates a brand-new array on every single call,
  // so useSyncExternalStore's snapshot never stabilizes — React detects the
  // "changed every render" snapshot and throws error #185 (Maximum update
  // depth exceeded), live-reproduced opening this page for a real project.
  // Selecting the stable `tasks` reference and filtering in a memo below
  // keeps the snapshot stable across renders that don't touch `tasks`.
  const tasks = useAppStore((s) => s.tasks)
  const allTasks = useMemo(() => tasks.filter((t) => t.projectId === projectId), [tasks, projectId])

  // Store actions
  const setTasks = useAppStore((s) => s.setTasks)
  const setActiveTask = useAppStore((s) => s.setActiveTask)

  // Local UI state
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<'all' | string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Bumped by refetch() to force the fetch effect below to re-run — there is
  // no other trigger for a manual reload (e.g. right after task.create).
  const [refetchTrigger, setRefetchTrigger] = useState(0)
  const refetch = useCallback(() => setRefetchTrigger((n) => n + 1), [])

  // Fetch tasks when projectId changes
  useEffect(() => {
    if (!projectId) {
      return
    }
    setIsLoading(true)
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    // Why {tasks, nextPageToken}, not a bare array: the Go handler
    // (channels_automation_task.go's task.list) returns the raw
    // ListTasksResponse proto, which JSON-marshals with its own `tasks`
    // field — live-reproduced as "s.filter is not a function" when the
    // whole wrapper object was stored as if it were the task array itself.
    // `?? []` covers an empty/nil `tasks` field (proto3's nil-slice
    // omitempty serializes as JSON null here — see automationsListView's
    // own doc comment on the same BUG-005 gap for other list channels).
    callRuntimeRpc<{ tasks: OrcaTask[] | null }>(target, 'task.list', { projectId })
      .then((response) => {
        if (typeof setTasks === 'function') {
          // Since our setTasks currently replaces all tasks in the store (as per Option B flat approach),
          // We only set the tasks for the current project for now. Real world we'd append or use tasksByProject
          setTasks(response.tasks ?? [])
        }
      })
      .catch(() => {
        /* silently fail */
      })
      .finally(() => setIsLoading(false))
  }, [projectId, setTasks, refetchTrigger])

  // Filter + search
  const filteredTasks = useMemo(() => {
    return allTasks.filter((task) => {
      if (filterStatus !== 'all' && task.status !== filterStatus) {
        return false
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        return task.title.toLowerCase().includes(q) || task.id.toLowerCase().includes(q)
      }
      return true
    })
  }, [allTasks, filterStatus, searchQuery])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  return {
    filteredTasks,
    expandedNodes,
    toggleExpanded,
    setActiveTask: setActiveTask ?? (() => {}),
    filterStatus,
    setFilterStatus,
    searchQuery,
    setSearchQuery,
    isLoading,
    refetch,
    dagView: null // future: DAG graph data
  }
}
