import { useState, useCallback } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import { Tracers } from '../../../shared/trace/tracers'
import { toast } from 'sonner'
import type { WorkflowDefinition, WorkflowStep } from '@shared/workflow-types'

export function useWorkflow(templateId?: string) {
  const { templates, executions } = useAppStore((s) => ({
    templates: s.templates,
    executions: s.executions
  }))
  const template = templateId ? (templates.find((t) => t.id === templateId) ?? null) : null
  const [local, setLocal] = useState<Partial<WorkflowDefinition>>(template ?? {})

  const updateTemplate = useCallback((patch: Partial<WorkflowDefinition>) => {
    setLocal((prev) => ({ ...prev, ...patch }))
  }, [])

  const addStep = useCallback(() => {
    const newStep: WorkflowStep = {
      id: `step-${Date.now()}`,
      type: 'agent',
      name: `Step ${(local.steps?.length ?? 0) + 1}`,
      serverSpec: 'project:current',
      config: { type: 'agent', prompt: '', worktreePath: '.' },
      dependsOn: [],
      continueOnError: false,
      timeout: 1800
    }
    setLocal((prev) => ({ ...prev, steps: [...(prev.steps ?? []), newStep] }))
    return newStep.id
  }, [local.steps])

  const removeStep = useCallback((stepId: string) => {
    setLocal((prev) => ({
      ...prev,
      steps: (prev.steps ?? [])
        .filter((s) => s.id !== stepId)
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== stepId) }))
    }))
  }, [])

  const updateStep = useCallback((stepId: string, patch: Partial<WorkflowStep>) => {
    setLocal((prev) => ({
      ...prev,
      steps: (prev.steps ?? []).map((s) => (s.id === stepId ? { ...s, ...patch } : s))
    }))
  }, [])

  const saveTemplate = useCallback(async () => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    // BL-WF-01: field `mode` phân biệt create/update.
    const span = Tracers.uiWorkflowTemplateSaveFlow.start({
      mode: templateId ? 'update' : 'create'
    })
    try {
      // BACKLOG-020: workflow.template.create/.update's real wscompat shape
      // (channels_workflow.go's createArgs/updateArgs) is
      // {name, dagJson, scope, parentTemplateId[, id, expectedVersion]} —
      // `dagJson` is a JSON-encoded STRING of the definition, not a nested
      // `definition` object, and the template's own id is `id`, not
      // `templateId` (that name is reserved for workflow.execute's target).
      // json.Unmarshal on the Go side silently ignores unknown keys and
      // zero-values missing ones, so the previous {templateId, definition}
      // shape here decoded to an empty id/dagJson on every call — a live
      // bug, just invisible because WorkflowBuilder.tsx (this hook's only
      // caller) isn't mounted anywhere in the app yet. No `traceId` field
      // exists on either RPC — dropped, not renamed.
      const dagJson = JSON.stringify({ steps: local.steps ?? [] })
      if (templateId) {
        await callRuntimeRpc(target, 'workflow.template.update', {
          id: templateId,
          name: local.name,
          dagJson,
          scope: local.scope
        })
      } else {
        const created = await callRuntimeRpc<WorkflowDefinition>(
          target,
          'workflow.template.create',
          {
            name: local.name,
            dagJson,
            scope: local.scope
          }
        )
        useAppStore.getState().addTemplate(created)
      }
      span.ok({ mode: templateId ? 'update' : 'create' })
      toast.success('Workflow saved')
    } catch (err) {
      span.fail(err, { mode: templateId ? 'update' : 'create' })
      throw err
    }
  }, [templateId, local])

  const runWorkflow = useCallback(
    async (inputs?: Record<string, unknown>) => {
      if (!templateId) {
        toast.error('Save workflow first')
        return null
      }
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      // BL-WF-02: span.id CHÍNH LÀ rootTraceId của toàn bộ execution. Browser sinh
      // id này TRƯỚC khi có executionId từ backend.
      const span = Tracers.uiWorkflowExecuteFlow.start({ templateId })
      try {
        // BACKLOG-020: workflow.execute's real shape is
        // {templateId, projectId, rootTraceId, requestId} — no `inputs` field
        // exists on the RPC (ExecuteRequest carries no per-run input payload
        // today; `inputs` was silently dropped by the Go decoder same as
        // above), and `traceId` needed to be `rootTraceId` to actually land
        // as this execution's root trace id per BL-WF-02's own comment.
        void inputs
        const result = await callRuntimeRpc<{ id: string }>(target, 'workflow.execute', {
          templateId,
          rootTraceId: span.id,
          requestId: span.id
        })
        // Lưu rootTraceId vào execution record ngay khi biết executionId.
        useAppStore.getState().addExecution({
          id: result.id,
          templateId,
          status: 'running',
          startedAt: Date.now(),
          triggeredBy: 'me',
          definition: local as WorkflowDefinition,
          rootTraceId: span.id
        })
        // KHÔNG span.ok() ở đây tới khi execution xong — ok() chỉ đánh dấu "RPC issue
        // thành công" (ack nhận executionId), không phải "execution đã xong". Vòng đời
        // đầy đủ do backend tự trace qua workflow:execute (resume cùng id).
        span.ok({ executionId: result.id })
        toast.success('Workflow started')
        return result.id
      } catch (err) {
        span.fail(err, { templateId })
        toast.error('Failed to start workflow')
        return null
      }
    },
    [templateId, local]
  )

  return {
    template: local,
    templates,
    executions,
    addStep,
    removeStep,
    updateStep,
    updateTemplate,
    saveTemplate,
    runWorkflow
  }
}
