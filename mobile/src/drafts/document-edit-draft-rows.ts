import * as z from 'zod'
import {
  DEVICE_STORE_MAX_VALUE_LENGTH,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'
import {
  durableDraftRow,
  durableDraftRowKey,
  pageDraftRowBackend,
  resetDurableDraftRowsForTests,
  type DurableDraftRow
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

/** The host and remote runtime a worktree lives on, so two hosts' same-named documents never share edits. */
export type DocumentEditScope = { hostId: string; executionHost?: string; worktreeId: string }

function scopedId(scope: DocumentEditScope, id: string): string {
  return `${scope.hostId}:${scope.executionHost ?? ''}:${id}`
}

export function markdownTabDraftKey(scope: DocumentEditScope, tabId: string): string {
  return durableDraftRowKey('markdownTab', scope.worktreeId, scopedId(scope, tabId))
}

export function fileEditDraftKey(scope: DocumentEditScope, path: string): string {
  return durableDraftRowKey('fileEdit', scope.worktreeId, scopedId(scope, path))
}

// A value past the store's cap would be refused and leave older edits behind, so it is not kept at all.
function fitsDeviceStore(draft: DocumentEditDraft): boolean {
  const json = JSON.stringify(draft)
  // At most 3 UTF-8 bytes per code unit, gzip barely grows any input, base64 adds a third: most documents skip the encode.
  if (json.length * 4 + 1024 <= DEVICE_STORE_MAX_VALUE_LENGTH) {
    return true
  }
  return encodeDeviceStoreValue(draft).length <= DEVICE_STORE_MAX_VALUE_LENGTH
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
