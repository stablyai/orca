import {
  MAX_DASHBOARD_TASK_NOTES,
  taskNoteMutationSchema,
  taskNotesSchema,
  type DashboardTaskNoteChange,
  type DashboardTaskNoteMutation,
  type DashboardTaskNotes
} from '../../../shared/dashboard-task-notes'
import type { StoreRuntimeState } from './store-runtime-state'

type NoteRuntime = Pick<
  StoreRuntimeState,
  'state' | 'runDurableMutation' | 'dirtyProfileStateDomains'
>

export function getProfileDashboardTaskNotes(runtime: NoteRuntime): DashboardTaskNotes {
  return taskNotesSchema.parse(runtime.state.dashboardTaskNotes ?? {})
}

export async function loadProfileDashboardTaskNotes(
  runtime: NoteRuntime
): Promise<DashboardTaskNotes> {
  const result = await runtime.runDurableMutation<DashboardTaskNotes | Error>(() => {
    const parsed = taskNotesSchema.safeParse(runtime.state.dashboardTaskNotes ?? {})
    return {
      persist: false,
      writtenHostIds: [],
      value: parsed.success ? parsed.data : new Error('Saved dashboard task notes are invalid')
    }
  })
  if (result instanceof Error) {
    throw result
  }
  return result
}

export async function saveProfileDashboardTaskNote(
  runtime: NoteRuntime,
  input: DashboardTaskNoteMutation
): Promise<DashboardTaskNoteChange> {
  const mutation = taskNoteMutationSchema.parse(input)
  const result = await runtime.runDurableMutation<DashboardTaskNoteChange | Error>(() => {
    const parsed = taskNotesSchema.safeParse(runtime.state.dashboardTaskNotes ?? {})
    if (!parsed.success) {
      return {
        persist: false,
        writtenHostIds: [],
        value: new Error('Saved dashboard task notes are invalid')
      }
    }
    const previous = parsed.data
    const existing = previous[mutation.key]
    if (mutation.mode === 'import-if-missing' && existing) {
      return { persist: false, writtenHostIds: [], value: { key: mutation.key, note: existing } }
    }
    if (!existing && Object.keys(previous).length >= MAX_DASHBOARD_TASK_NOTES) {
      return {
        persist: false,
        writtenHostIds: [],
        value: new Error('Dashboard task note limit reached')
      }
    }
    const next = { ...previous, [mutation.key]: mutation.note }
    runtime.state.dashboardTaskNotes = next
    runtime.dirtyProfileStateDomains?.add('dashboardTaskNotes')
    return {
      value: { key: mutation.key, note: mutation.note },
      writtenHostIds: [],
      rollback: () => {
        if (runtime.state.dashboardTaskNotes === next) {
          runtime.state.dashboardTaskNotes = previous
        }
      }
    }
  })
  if (result instanceof Error) {
    throw result
  }
  return result
}
