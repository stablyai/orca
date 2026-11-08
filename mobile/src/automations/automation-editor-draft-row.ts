import * as z from 'zod'
import {
  durableDraftRow,
  durableDraftRowKey,
  pageDraftRowBackend,
  resetDurableDraftRowsForTests,
  type DurableDraftRow
} from '../drafts/durable-draft-rows'
import { automationDraftChanged, type AutomationDraft } from './automation-draft'

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
  })
  .partial()

type Slot = { edits: AutomationDraftEdits | null; row: DurableDraftRow }
const slots = new Map<string, Slot>()

/** One row per authority (the paired host, or a server) and automation, `new` for a create. */
export function automationEditorDraftKey(executionHost?: string, automationId?: string): string {
  return durableDraftRowKey(
    'automation',
    '',
    `${executionHost ?? 'paired'}:${automationId ?? 'new'}`
  )
}

export function automationDraftEdits(
  original: AutomationDraft,
  draft: AutomationDraft
): AutomationDraftEdits | null {
  if (!automationDraftChanged(original, draft)) {
    return null
  }
  const before = new Map(Object.entries(original))
  return Object.fromEntries(
    Object.entries(draft).filter(([key, value]) => value !== before.get(key))
  )
}

function slotFor(key: string): Slot {
  let slot = slots.get(key)
  if (!slot) {
    const created: Slot = {
      edits: null,
      row: durableDraftRow(key, {
        backend: () => pageDraftRowBackend(key),
        snapshot: () => created.edits,
        restore: (saved) => {
          const parsed = editsSchema.safeParse(saved)
          created.edits ??= parsed.success ? parsed.data : null
        }
      })
    }
    slot = created
    slots.set(key, slot)
  }
  return slot
}

/** The page's copy, once the row has been read; null before then. */
export function readAutomationEditorDraft(key: string): AutomationDraftEdits | null {
  const slot = slotFor(key)
  return slot.row.state() === 'loaded' ? slot.edits : null
}

export async function loadAutomationEditorDraft(key: string): Promise<AutomationDraftEdits | null> {
  const slot = slotFor(key)
  await slot.row.load()
  return slot.edits
}

export function saveAutomationEditorDraft(key: string, edits: AutomationDraftEdits | null): void {
  const slot = slotFor(key)
  slot.edits = edits
  slot.row.save(edits ? 'deferred' : 'immediate')
}

// Edits the host now holds must not come back.
export function dropAutomationEditorDraft(executionHost?: string, automationId?: string): void {
  saveAutomationEditorDraft(automationEditorDraftKey(executionHost, automationId), null)
}

export function resetAutomationEditorDraftsForTests(): void {
  slots.clear()
  resetDurableDraftRowsForTests()
}
