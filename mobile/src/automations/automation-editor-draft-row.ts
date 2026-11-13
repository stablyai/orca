import * as z from 'zod'
import {
  durableDraftRow,
  durableDraftRowKey,
  pageDraftRowBackend,
  resetDurableDraftRowsForTests,
  type DurableDraftRow
} from '../drafts/durable-draft-rows'
import type { AutomationDraft } from './automation-draft'

// Only the fields the user changed are kept, so a field edited elsewhere since then is not reverted.
export type AutomationDraftEdits = Partial<AutomationDraft>

const editsSchema = z
  .object({
    targetEdited: z.boolean(),
    setupDecisionEdited: z.boolean(),
    name: z.string(),
    prompt: z.string(),
    agentId: z.string().nullable(),
    surface: z.string(),
    setupId: z.string(),
    workspaceId: z.string(),
    workspaceMode: z.enum(['existing', 'new_per_run']),
    rrule: z.string(),
    timezone: z.string(),
    baseBranch: z.string(),
    setupDecision: z.enum(['inherit', 'run', 'skip']),
    reuseSession: z.boolean(),
    extraAgentArgs: z.string(),
    precheckCommand: z.string(),
    precheckTimeout: z.string(),
    grace: z.string()
  } satisfies Record<keyof AutomationDraft, z.ZodType>)
  .partial()

type Slot = {
  edits: AutomationDraftEdits | null
  // A drop before the row was read: the stored copy is what was dropped, so it never comes back.
  dropped: boolean
  // Dropped since the editor opened: that editor's later typing is not saved (its automation may exist now).
  closed: boolean
  // The open editor, told whenever a read (the first or a retried one) brings saved edits.
  onRestore: ((edits: AutomationDraftEdits) => void) | null
  row: DurableDraftRow
}
const slots = new Map<string, Slot>()

/** One row per authority (the paired host, or a server) and automation, `new` for a create. */
export function automationEditorDraftKey(executionHost?: string, automationId?: string): string {
  return durableDraftRowKey(
    'automation',
    '',
    `${executionHost ?? 'paired'}:${automationId ?? 'new'}`
  )
}

/** Lays saved edits over the form, except on fields the user has changed since it opened. */
export function laySavedEdits(
  form: AutomationDraft,
  original: AutomationDraft,
  edits: AutomationDraftEdits
): AutomationDraft {
  const before = new Map(Object.entries(original))
  const now = new Map(Object.entries(form))
  const untouched = Object.entries(edits).filter(([key]) => now.get(key) === before.get(key))
  return untouched.length ? { ...form, ...Object.fromEntries(untouched) } : form
}

function slotFor(key: string): Slot {
  let slot = slots.get(key)
  if (!slot) {
    const created: Slot = {
      edits: null,
      dropped: false,
      closed: false,
      onRestore: null,
      row: durableDraftRow(key, {
        backend: () => pageDraftRowBackend(key),
        snapshot: () => created.edits,
        restore: (saved) => {
          const parsed = editsSchema.safeParse(saved)
          if (created.dropped || !parsed.success || Object.keys(parsed.data).length === 0) {
            return
          }
          // Fields typed before the read landed win over the saved copy.
          created.edits = { ...parsed.data, ...created.edits }
          created.onRestore?.(created.edits)
        }
      })
    }
    slot = created
    slots.set(key, slot)
  }
  return slot
}

/** The page's copy: what was read, plus typing kept in memory while the store can't be read. */
export function readAutomationEditorDraft(key: string): AutomationDraftEdits | null {
  return slotFor(key).edits
}

/** Opens the row for an editor: reads it if it hasn't been, and hands saved edits to `onRestore`. */
export function watchAutomationEditorDraft(
  key: string,
  onRestore: (edits: AutomationDraftEdits) => void
): () => void {
  const slot = slotFor(key)
  slot.closed = false
  slot.onRestore = onRestore
  void slot.row.load()
  return () => {
    if (slot.onRestore === onRestore) {
      slot.onRestore = null
    }
  }
}

export function saveAutomationEditorDraft(key: string, edits: AutomationDraftEdits | null): void {
  const slot = slotFor(key)
  if (slot.closed) {
    return
  }
  slot.edits = edits
  slot.row.save(edits ? 'deferred' : 'immediate')
}

// Discarded edits, and edits the host now holds, must not come back.
export function discardAutomationEditorDraft(key: string): void {
  const slot = slotFor(key)
  slot.dropped ||= slot.row.state() === 'pending'
  saveAutomationEditorDraft(key, null)
  slot.closed = true
}

export function dropAutomationEditorDraft(executionHost?: string, automationId?: string): void {
  discardAutomationEditorDraft(automationEditorDraftKey(executionHost, automationId))
}

export function resetAutomationEditorDraftsForTests(): void {
  slots.clear()
  resetDurableDraftRowsForTests()
}
