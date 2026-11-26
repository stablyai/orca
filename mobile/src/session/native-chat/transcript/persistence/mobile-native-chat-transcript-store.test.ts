import { afterEach, expect, it } from 'vitest'
import { publishPageDeviceStore } from '../../../../mobile-web-shell/bridge/page-storage/page-device-store'
import { encodeDeviceStoreValue } from '../../../../device-store/device-store-value-codec'
import {
  chatTranscriptStoreKey,
  peekStoredChatTranscript,
  primeStoredChatTranscripts,
  rememberStoredChatTranscript,
  storedTabChatTranscriptKeys,
  STORED_TRANSCRIPT_VERSION,
  type StoredStructuredChatTranscript
} from './mobile-native-chat-transcript-store'

afterEach(() => publishPageDeviceStore(null))

it('keeps the offline copy and live transcript identity through two provider changes', async () => {
  const keys = (agent: string) =>
    storedTabChatTranscriptKeys('host', 'worktree', {
      type: 'agent-session',
      agent,
      sessionId: 'conversation'
    })!
  const claude = keys('claude')
  const codex = keys('codex')
  const saved: StoredStructuredChatTranscript = {
    kind: 'structured',
    savedAt: 1,
    journal: {
      epoch: 'epoch',
      cursor: { epoch: 'epoch', sequence: 0 },
      fence: 1,
      items: [],
      submissions: [],
      hasOlder: false
    }
  }
  const oldKey = chatTranscriptStoreKey(claude.legacyIdentity!)
  const oldValue = encodeDeviceStoreValue({ v: STORED_TRANSCRIPT_VERSION, stored: saved })
  publishPageDeviceStore({
    available: () => true,
    read: async (_table, identities) => ({
      status: 'ok',
      values: identities.map((identity) => (identity === oldKey ? oldValue : null))
    }),
    write: async () => ({ written: true })
  })
  await primeStoredChatTranscripts([claude])
  expect(peekStoredChatTranscript(claude.identity)).toEqual(saved)
  expect(codex.identity).toBe(claude.identity)
  const live = { ...saved, savedAt: 2 }
  rememberStoredChatTranscript(codex.identity, live)
  expect(peekStoredChatTranscript(keys('claude').identity)).toBe(live)
})
