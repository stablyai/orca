// A group post's chat attachments, admitted on the group's host as chat and item comments admit
// theirs: images live in this host's attachment store under chat's limits, and every referenced
// upload is claimed for each current room member so it outlives individual turns and sweeps with the room.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupMessage, BotGroupMessageImage } from '../../shared/bots/bot-group'
import { stripSentImagePromptMarkers } from '../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { agentSessionAttachmentReferences } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { AgentSessionAttachmentClaimer } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  admitStoredAttachmentImages,
  claimAttachmentBody,
  copyLocalAttachmentToStore,
  hasAttachmentStoreReference,
  type BotAttachmentStore
} from './bot-attachment-images'

const GROUP_IMAGE_LABELS = {
  plural: 'Group messages',
  singular: 'A group message',
  surface: 'in a group message'
} as const

export type BotGroupAttachmentDeps = {
  store: BotAttachmentStore | null
  /** This host's own window sent: a dropped on-disk image is copied in; paired clients name store paths only. */
  local: boolean
  claim: AgentSessionAttachmentClaimer | null
  /** Current room member sessions that keep referenced uploads alive. */
  memberSessionIds: readonly string[]
}

/** Validates, copies (when local), and claims every upload a group message names. */
export async function admitBotGroupMessageAttachments(
  deps: BotGroupAttachmentDeps,
  text: string,
  paths: readonly string[]
): Promise<BotGroupMessageImage[]> {
  const { store } = deps
  if (!store) {
    if (paths.length > 0 || hasAttachmentStoreReference(text)) {
      throw refused(
        "This computer can't take attachments right now. Try sending again in a moment."
      )
    }
    return []
  }
  const uniquePaths = [...new Set(paths)]
  const copies = deps.local
    ? await Promise.all(uniquePaths.map((path) => copyLocalAttachmentToStore(store, path, refused)))
    : uniquePaths
  // One image per attachment, in order, so [Image #N] markers and the byte limit see every one.
  const images = await admitStoredAttachmentImages(
    store,
    paths.map((path) => copies[uniquePaths.indexOf(path)]),
    GROUP_IMAGE_LABELS,
    refused
  )
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text },
      ...images.map(({ path }) => ({ type: 'image-ref' as const, path }))
    ]
  }
  if (agentSessionAttachmentReferences(store.rootDir, body).size === 0) {
    return images
  }
  if (!deps.claim || deps.memberSessionIds.length === 0) {
    throw refused("Couldn't attach the files. Try sending again in a moment.")
  }
  await claimAttachmentBody(deps.claim, deps.memberSessionIds, body, {
    logPrefix: '[bot-groups] claiming group message attachments failed',
    retryMessage: "Couldn't attach the files. Try sending again in a moment.",
    refused
  })
  return images
}

/** One-line summary for thread titles and sidebar previews, handling image-only posts. */
export function botGroupMessageSummary(message: Pick<BotGroupMessage, 'text' | 'images'>): string {
  const images = message.images ?? []
  const prose = stripSentImagePromptMarkers(message.text, images.length).replace(/\s+/g, ' ').trim()
  if (prose) {
    return prose
  }
  if (images.length === 1) {
    return images[0].name
  }
  return images.length > 1 ? `${images.length} images` : ''
}

function refused(message: string): Error {
  return new Error(message)
}
