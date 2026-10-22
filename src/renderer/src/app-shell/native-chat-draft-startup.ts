import { useAppStore } from '../store'
import { resolveNativeChatDraftOwner } from '../lib/native-chat-draft-owner'
import {
  hydrateNativeChatComposerDrafts,
  setNativeChatComposerDraftOwnerResolver,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import { recheckNativeChatComposerDraftImagesIn } from '@/components/native-chat/native-chat-composer-draft-image-check'

// Why bounded: loading drafts is bookkeeping and must never hold startup; a slower load still
// fills in every draft not edited meanwhile when it lands.
const DRAFT_LOAD_WAIT_MS = 1_500

/** Before any startup step, so a step that fails can't leave the drafts unloaded. */
export function startNativeChatDraftLoad(): (() => void) | undefined {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), scopeKey)
  )
  // Before the load: a removal after a draft's restore check must reach it.
  const stopRechecks = window.api?.ui?.onAgentSessionUploadRemoved?.(
    recheckNativeChatComposerDraftImagesIn
  )
  void hydrateNativeChatComposerDrafts()
  return stopRechecks
}

/** Startup waits for the drafts alongside the session read, so a composer shows its draft from
 *  its first frame. */
export function waitForNativeChatDraftsAtStartup(): Promise<void> {
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}
