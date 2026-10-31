import { useLayoutEffect, useRef } from 'react'
import type { operationModuleLoader } from './operation-module-loader'
import type { ActionableTaskItem } from '../../tasks/mobile-tasks-project-workspace-types'
import type { DetailPayload } from '../../tasks/mobile-tasks-provider-detail-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MountContext } from './recording-scenario'
import { projectObservable } from './observable-model'
import { captureValue, type RecordedValue } from './recording-values'

// Recording projections use the same native mutation, selection and file owners as the screen.
function useTaskStateAndSelection(
  modules: ReturnType<typeof operationModuleLoader>,
  model: Record<string, unknown>,
  fixture: Record<string, unknown>
) {
  const { useMobileTasksItemState } = modules.load<
    typeof import('../../tasks/use-mobile-tasks-item-state')
  >('mobile/src/tasks/use-mobile-tasks-item-state.tsx')
  const { useMobileTasksSelection, githubTaskKey } = modules.load<
    typeof import('../../tasks/github-task-identity')
  >('mobile/src/tasks/github-task-identity.ts')
  const state = useMobileTasksItemState()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mount adapter stores its actual recording client in this field.
  const selection = useMobileTasksSelection(model.client as RpcClient, state.detailPayload)
  useLayoutEffect(() => {
    const isStateKey = (key: string): key is keyof typeof state => key in state
    for (const [field, value] of Object.entries(fixture)) {
      const setterName = `set${field[0].toUpperCase()}${field.slice(1)}`
      const setter: unknown = isStateKey(setterName) ? state[setterName] : undefined
      if (typeof setter === 'function') {
        setter(value)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: action adapters declare the concrete provider fixture they dispatch below.
    const selected = (fixture.actionItem ?? null) as ActionableTaskItem | null
    selection.setActionItem(selected)
    if (
      selected?.provider === 'github' &&
      fixture.detailPayload &&
      typeof fixture.detailPayload === 'object'
    ) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's declared GitHub detail fixture supplies the consumed members; provenance comes from its selected item.
      state.setDetailPayload({
        ...fixture.detailPayload,
        targetKey: githubTaskKey(selected.source)
      } as DetailPayload)
    }
  }, [])
  return { state, selection }
}

// Observe the committed projection, leaving the real owner and every setter untouched.
export function useCommittedOwnerProjection(
  context: MountContext,
  owners: Record<string, unknown>
) {
  const previous = useRef<Record<string, RecordedValue> | null>(null)
  useLayoutEffect(() => {
    const next: Record<string, RecordedValue> = {}
    for (const field of Object.keys(owners).sort()) {
      const value = owners[field]
      if (typeof value === 'function' || field === 'copiedLinkResetTimerRef') {
        continue
      }
      const read = () => {
        const projected = projectObservable(value)
        return { projected, captured: captureValue(projected) }
      }
      const { projected, captured } = context.captureObservation
        ? context.captureObservation('committed owner projection', read)
        : read()
      next[field] = captured
      if (
        !previous.current ||
        JSON.stringify(previous.current[field]) !== JSON.stringify(next[field])
      ) {
        context.effect(field, projected)
      }
    }
    previous.current = next
  })
}

export function useTaskActionMountOwners(
  modules: ReturnType<typeof operationModuleLoader>,
  context: MountContext,
  model: Record<string, unknown>,
  fixture: Record<string, unknown>
): void {
  const { state, selection } = useTaskStateAndSelection(modules, model, fixture)
  const { useMobileTasksMutation } = modules.load<
    typeof import('../../tasks/use-mobile-tasks-workspace-and-project-state')
  >('mobile/src/tasks/use-mobile-tasks-workspace-and-project-state.tsx')
  const mutation = useMobileTasksMutation()
  const owners = { ...state, ...mutation, ...selection }
  Object.assign(model, owners, {
    captureTaskListRefresh: () => () => {
      if (typeof fixture.loadTasks === 'function') {
        void fixture.loadTasks()
      }
    }
  })
  useCommittedOwnerProjection(context, owners)
}

export function useTaskDetailMountOwners(
  modules: ReturnType<typeof operationModuleLoader>,
  context: MountContext,
  model: Record<string, unknown>,
  fixture: Record<string, unknown>
): void {
  const { state, selection } = useTaskStateAndSelection(modules, model, fixture)
  const owners = {
    actionItem: selection.actionItem,
    setActionItem: selection.setActionItem,
    detailPayload: state.detailPayload,
    setDetailPayload: state.setDetailPayload,
    detailLoading: state.detailLoading,
    setDetailLoading: state.setDetailLoading,
    detailError: state.detailError,
    setDetailError: state.setDetailError,
    detailRefreshSeq: state.detailRefreshSeq,
    setDetailRefreshSeq: state.setDetailRefreshSeq
  }
  Object.assign(model, owners)
  useCommittedOwnerProjection(context, owners)
}

export function useTaskFileMountOwner(
  modules: ReturnType<typeof operationModuleLoader>,
  context: MountContext,
  model: Record<string, unknown>
): void {
  const { useMobileTasksItemState } = modules.load<
    typeof import('../../tasks/use-mobile-tasks-item-state')
  >('mobile/src/tasks/use-mobile-tasks-item-state.tsx')
  const state = useMobileTasksItemState()
  const owners = {
    expandedPrFilePath: state.expandedPrFilePath,
    setExpandedPrFilePath: state.setExpandedPrFilePath,
    prFileContents: state.prFileContents,
    setPrFileContents: state.setPrFileContents,
    prFileLoadingPath: state.prFileLoadingPath,
    prFileCommentDrafts: state.prFileCommentDrafts,
    setPrFileCommentDrafts: state.setPrFileCommentDrafts,
    beginFileLoad: state.beginFileLoad,
    resetPrFiles: state.resetPrFiles
  }
  Object.assign(model, owners)
  useCommittedOwnerProjection(context, owners)
}
