import type { QueuedEditLeaseLoss } from '../../../src/shared/queued-message-edit-lease'
import type { MobileStructuredAgentMutate } from './use-mobile-structured-agent-mutation'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'
import {
  mobileQueuedEditValueKey,
  sameMobileQueuedEditImage
} from './mobile-queued-message-edit-value'
import type {
  MobileNativeChatDraftInputs,
  MobileNativeChatDraftDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileQueuedEditLease } from './mobile-queued-message-edit-lease'
import { pickedSkillsInText } from '../../../src/shared/structured-agent-session-send-mutation'
import {
  queuedEditKeptImages,
  queuedEditTextForKeptImages
} from '../../../src/shared/queued-message-edit'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import {
  closeMobileNativeChatEditInputs,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import { nativeChatTextWithFileReferences } from './native-chat/composer/mobile-native-chat-file-attachment'

export type MobileQueuedMessageInlineEditor = {
  messageId: string
  scopeKey: string
  client: RpcClient
  sessionId: string
  imagesCapable: boolean
  text: string
  saving: boolean
  canSave: boolean
  insertDictation?: (insert: (draft: string) => string) => boolean
  change: (text: string) => void
  save: () => Promise<boolean>
  removeImage: (id: string) => void
  cancel: () => void
}

export type MobileQueuedEditAttempt = {
  phase: 'pending' | 'unknown'
  expected: string
  fingerprint: string
  body: AgentSessionQueuedMessage['body']
  text: string
  inputs: MobileNativeChatDraftInputs
  key: string
}
export function mobileQueuedEditSaving(edit: MobileQueuedEditDraft): boolean {
  return edit.attempt?.phase === 'pending'
}

export type MobileQueuedEditDraft = {
  scope: string
  client: RpcClient
  sessionId: string
  published: {
    cards: readonly MobileQueuedMessageCard[]
    messages: readonly AgentSessionQueuedMessage[] | null
    submissions: readonly AgentJournalSubmission[]
  }
  scopeKey: string
  destination: MobileNativeChatDraftDestination | null
  handBackText: ((text: string) => boolean) | undefined
  messageId: string
  body: AgentSessionQueuedMessage['body']
  text: string
  fingerprint: string
  baseKey: string
  kept: {
    image: MobileNativeChatDraftInputs['images'][number]
    block: ReturnType<typeof queuedEditKeptImages>[number]['block']
  }[]
  uncertain: boolean
  leaseLoss?: QueuedEditLeaseLoss
  attempt?: MobileQueuedEditAttempt
  closed: boolean
  pendingClose: boolean
  lease: MobileQueuedEditLease
}

export function closeMobileQueuedEditDraft(
  edit: MobileQueuedEditDraft,
  handBack: boolean,
  notice?: (text: string) => void
): void {
  if (edit.closed) {
    return
  }
  edit.closed = true
  edit.lease.end()
  if (handBack && (edit.destination?.active ?? true)) {
    const inputs = readMobileNativeChatDraftInputs(edit.scopeKey)
    const dirty = edit.uncertain || mobileQueuedEditValueKey(edit.text, inputs) !== edit.baseKey
    const kept = edit.kept.filter((entry) =>
      inputs.images.some((image) => sameMobileQueuedEditImage(entry.image, image))
    )
    const text = dirty
      ? queuedEditTextForKeptImages(
          edit.text,
          inputs.images.map(({ id }) => id),
          inputs.images
            .filter((image) => !kept.some((entry) => sameMobileQueuedEditImage(entry.image, image)))
            .map(({ id }) => id)
        )
      : ''
    if (dirty && edit.destination) {
      setMobileNativeChatDraftText(edit.destination, (before) =>
        appendReturnedDraftText(before, text)
      )
    } else if (dirty) {
      edit.handBackText?.(text)
    }
    closeMobileNativeChatEditInputs(
      edit.scopeKey,
      edit.destination ?? undefined,
      kept.map(({ image }) => image),
      !dirty
    )
    if (dirty) {
      notice?.('Your edit is in the chat box.')
    }
  } else {
    closeMobileNativeChatEditInputs(edit.scopeKey)
  }
}

export function serializeMobileQueuedEdit(
  edit: MobileQueuedEditDraft,
  imagesCapable = false,
  skillsCapable = false
) {
  const inputs = readMobileNativeChatDraftInputs(edit.scopeKey)
  return {
    text: nativeChatTextWithFileReferences(
      edit.text,
      inputs.files.flatMap(({ path }) => (path ? [{ path }] : []))
    ),
    ...(imagesCapable
      ? {
          images: inputs.images.map(
            (image) =>
              edit.kept.find((entry) => sameMobileQueuedEditImage(entry.image, image))?.block ?? {
                type: 'image-ref' as const,
                path: image.path
              }
          )
        }
      : {}),
    ...(skillsCapable ? { skills: pickedSkillsInText(edit.text, inputs.skills, ['$', '/']) } : {})
  }
}

export function removeMobileQueuedEditImage(edit: MobileQueuedEditDraft, id: string): void {
  const images = readMobileNativeChatDraftInputs(edit.scopeKey).images
  const kept = images.filter((image) => image.id !== id)
  edit.text = queuedEditTextForKeptImages(
    edit.text,
    images.map(({ id }) => id),
    kept.map(({ id }) => id)
  )
  updateMobileNativeChatDraftInputs(edit.scopeKey, (current) => ({
    ...current,
    images: kept
  }))
}

export function mobileQueuedEditSaveHeld(
  edit: MobileQueuedEditDraft,
  imagesCapable = false
): boolean {
  const inputs = readMobileNativeChatDraftInputs(edit.scopeKey)
  return (
    (inputs.pending ?? 0) > 0 ||
    inputs.files.some(({ path }) => path === null) ||
    (!imagesCapable &&
      JSON.stringify(inputs.images) !== JSON.stringify(edit.kept.map(({ image }) => image)))
  )
}

export function seedMobileQueuedEditInputs(
  scopeKey: string,
  body: AgentSessionQueuedMessage['body']
): void {
  updateMobileNativeChatDraftInputs(scopeKey, () => ({
    skills: body.skills ?? [],
    files: [],
    images: queuedEditKeptImages(body).map(({ id, block }) => ({
      id,
      path: block.path ?? block.url ?? '',
      previewUri: block.url ?? block.path ?? ''
    }))
  }))
}

// A handed-back edit takes the dictation in the composer it went back to.
export function insertMobileQueuedEditDictation(
  edit: MobileQueuedEditDraft,
  destination: MobileNativeChatDraftDestination,
  insert: (draft: string) => string
): boolean {
  if (!destination.active) {
    return false
  }
  if (destination.scope !== edit.scopeKey) {
    setMobileNativeChatDraftText(destination, insert)
  } else {
    edit.text = insert(edit.text)
  }
  return true
}

export type MobileStructuredQueuedEditArgs = {
  sessionKey: string
  sessionId: string | null
  client: RpcClient | null
  chatActive: boolean
  enabled: boolean
  imagesCapable?: boolean
  skillsCapable?: boolean
  composerScopeKey?: string | null
  messages: readonly AgentSessionQueuedMessage[] | null
  submissions?: readonly AgentJournalSubmission[]
  cards: readonly MobileQueuedMessageCard[]
  mutate: MobileStructuredAgentMutate
  appendComposerText: ((text: string) => boolean) | undefined
  onQueuedEditNotice?: (text: string) => void
  onSendError: (text: string) => void
  onActionResolved?: () => void
}
