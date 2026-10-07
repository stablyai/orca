import { useAppStore } from '../store'
import { resolveNativeChatDraftOwner } from '../lib/native-chat-draft-owner'
import {
  hydrateNativeChatComposerDrafts,
  setNativeChatComposerDraftOwnerResolver,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'

// Why bounded: loading drafts is bookkeeping and must never hold startup; a slower load still
// fills in every draft not edited meanwhile when it lands.
const DRAFT_LOAD_WAIT_MS = 1_500

/** Before any startup step, so a step that fails can't leave the drafts unloaded. */
export function startNativeChatDraftLoad(): void {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), scopeKey)
  )
  void hydrateNativeChatComposerDrafts()
}

/** Startup waits for the drafts alongside the session read, so a composer shows its draft from
 *  its first frame. */
export function waitForNativeChatDraftsAtStartup(): Promise<void> {
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}
