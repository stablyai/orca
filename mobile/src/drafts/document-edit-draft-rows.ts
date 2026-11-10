import * as z from 'zod'
import {
  durableDraftRow,
  fitsDeviceStore,
  pageDraftRowBackend,
  resetDurableDraftRowsForTests,
  workspaceDraftRowKey,
  type DurableDraftRow,
  type WorkspaceDraftScope
} from './durable-draft-rows'

/** Unsaved edits to a file or Markdown tab, with the hash of the host's version they were made against. */
export type DocumentEditDraft = { content: string; baseHash: string; savedAt: number }

const draftSchema = z.object({ content: z.string(), baseHash: z.string(), savedAt: z.number() })

type Slot = {
  draft: DocumentEditDraft | null
  // Set by the first save; what the row held before then no longer applies.
  saved: boolean
  // The row's edits are on offer in an editor, waiting for Restore or Discard.
  offered: boolean
  row: DurableDraftRow
}
const slots = new Map<string, Slot>()

export function markdownTabDraftKey(scope: WorkspaceDraftScope, tabId: string): string {
  return workspaceDraftRowKey('markdownTab', scope, tabId)
}

export function fileEditDraftKey(scope: WorkspaceDraftScope, path: string): string {
  return workspaceDraftRowKey('fileEdit', scope, path)
}

function slotFor(key: string): Slot {
  let slot = slots.get(key)
  if (!slot) {
    const created: Slot = {
      draft: null,
      saved: false,
      offered: false,
      row: durableDraftRow(key, {
        backend: () => pageDraftRowBackend(key),
        snapshot: () => (created.draft && fitsDeviceStore(created.draft) ? created.draft : null),
        restore: (value) => {
          const parsed = draftSchema.safeParse(value)
          if (!created.saved && parsed.success) {
            created.draft = parsed.data
          }
        }
      })
    }
    slot = created
    slots.set(key, slot)
  }
  return slot
}

/** Undefined while the row could not be read; an unread row must not be overwritten by a clean document. */
export async function loadDocumentEditDraft(
  key: string
): Promise<DocumentEditDraft | null | undefined> {
  const slot = slotFor(key)
  await slot.row.load()
  return slot.row.state() === 'loaded' ? slot.draft : undefined
}

export function saveDocumentEditDraft(key: string, draft: DocumentEditDraft | null): void {
  const slot = slotFor(key)
  slot.draft = draft
  slot.saved = true
  slot.row.save(draft ? 'deferred' : 'immediate')
}

export function holdDocumentEditDraftOffer(key: string, offered: boolean): void {
  slotFor(key).offered = offered
}

// The user threw the editor's edits away. Edits on offer stay until that offer's own Discard, and an unread row
// holds nothing from this page.
export function dropDocumentEditDraft(key: string): void {
  const slot = slotFor(key)
  if (!slot.offered && slot.row.state() === 'loaded') {
    saveDocumentEditDraft(key, null)
  }
}

export function resetDocumentEditDraftsForTests(): void {
  slots.clear()
  resetDurableDraftRowsForTests()
}
