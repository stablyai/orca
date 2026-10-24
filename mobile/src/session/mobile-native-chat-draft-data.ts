import { imageReferenceToken } from '../../../src/shared/native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from '../../../src/shared/native-chat-image-transcript-markers'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { composerSkillOccurrences } from '../../../src/shared/composer-skill-occurrences'
import { z } from 'zod'
import { SendImageRefBlock } from '../../../src/shared/rpc-contract/structured-agent-session-message-params'

export const MOBILE_CHAT_DRAFT_PREFIX = 'orca:mobileChatDraft:'
// Escaping a legacy maximum-size message still fits, including its references and another draft.
export const MOBILE_CHAT_DRAFT_MAX_BYTES = 3 * 1024 * 1024
export const MOBILE_CHAT_DRAFT_CHUNK_CHARS = 48 * 1024
export const mobileChatDraftSchema = z.object({
  text: z.string(),
  images: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        connectionId: z.string().optional(),
        reference: z
          .preprocess(
            (value) =>
              value && typeof value === 'object' && !Array.isArray(value)
                ? { type: 'image-ref', ...value }
                : value,
            SendImageRefBlock
          )
          .transform(({ type: _type, ...reference }) => reference)
          .optional(),
        previewUri: z.string().optional()
      })
    )
    .default([]),
  skills: z.array(z.object({ name: z.string(), path: z.string() })).optional()
})

export function mobileChatDraftStorageKey(scope: string): string {
  return MOBILE_CHAT_DRAFT_PREFIX + scope.split('\0').map(encodeURIComponent).join(':')
}

export function mobileChatDraftKeyScope(key: string): string[] | null {
  if (!key.startsWith(MOBILE_CHAT_DRAFT_PREFIX)) {
    return null
  }
  try {
    const parts = key.slice(MOBILE_CHAT_DRAFT_PREFIX.length).split(':').map(decodeURIComponent)
    return parts.length === 3 && parts[0] && parts[1] ? parts : null
  } catch {
    return null
  }
}

export function parseMobileChatDraft(
  value: string | null
): z.infer<typeof mobileChatDraftSchema> | null {
  if (value === null) {
    return null
  }
  try {
    // Original references omit the block discriminator inside the draft.
    const raw: unknown = JSON.parse(value)
    if (typeof raw === 'string') {
      return { text: raw, images: [] }
    }
    const parsed = mobileChatDraftSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export type Draft = {
  text: string
  images: PendingNativeChatImage[]
  skills?: { name: string; path: string }[]
  editGeneration: number
}
export function combine(
  current: Draft,
  addition: Pick<Draft, 'text' | 'images' | 'skills'>,
  recovery = false
): Draft {
  const images = [...current.images]
  let text = promptMarkersToImageReferences(
    addition.text,
    addition.images.map((image) => image.id)
  )
  for (const image of addition.images) {
    const collision = images.find((held) => held.id === image.id)
    if (collision && JSON.stringify(collision) === JSON.stringify(image)) {
      continue
    }
    const id = collision ? `${image.id}-${current.editGeneration}-${images.length}` : image.id
    text = text.replaceAll(imageReferenceToken(image.id), imageReferenceToken(id))
    images.push({ ...image, id })
  }
  const original = promptMarkersToImageReferences(
    current.text,
    current.images.map((image) => image.id)
  )
  return {
    text: imageReferencesToPromptMarkers(
      recovery
        ? original && text
          ? `${original}\n\n${text}`
          : original + text
        : appendReturnedDraftText(original, text, 'append-repeated'),
      images.map((image) => image.id)
    ),
    images,
    skills: [
      ...composerSkillOccurrences(current.text, current.skills ?? []).map(({ ref }) => ref),
      ...composerSkillOccurrences(addition.text, addition.skills ?? []).map(({ ref }) => ref)
    ],
    editGeneration: current.editGeneration + 1
  }
}
