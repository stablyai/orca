// The finished run chat closer on this host: its chat records, settings and the bot chat close.
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveHostOwnedSetting } from '../../shared/settings/host-owned-settings'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { findLinksForSession } from '../external-conversations/external-conversation-links'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence/loading-store/store'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { structuredSessionMailReach } from '../runtime/orchestration/mailbox/routing/structured-session-mail-address'
import { botTurns } from './bot-automation-sessions'
import { closeBotSession } from './bot-chat-session'
import { BotRunChatCloser } from './bot-run-chat-close'

/** The session a chat runs in now; a /clear moves it on while the chat keeps its first id. */
function liveSession(sessionId: string): string {
  const records = readAgentSessionRecordStore()
  return (records && lineageLiveSession(records, sessionId)?.sessionId) ?? sessionId
}

/** Starts the closer on this host's runtime and keeps its timer in step with Close after. */
export function startBotRunChatCloser(runtime: OrcaRuntimeService, store: Store): BotRunChatCloser {
  const closer = new BotRunChatCloser({
    path: () => join(getProfileUserDataPath(), 'bot-run-chat-close.jsonl'),
    read: (path) => readFile(path, 'utf8').catch(() => null),
    append: (path, text) => appendFile(path, text, { mode: 0o600 }),
    write: (path, text) => writePluginFileAtomically(path, text, { mode: 0o600 }),
    now: () => Date.now(),
    bots: () => runtime.bots.list(),
    hostDefault: () => resolveHostOwnedSetting(store.getSettings(), 'botRunChatsCloseAfter'),
    ready: async () => {
      await runtime.ensureStructuredAgentSessionHost()
      if (!readAgentSessionRecordStore()) {
        throw new Error('chat records unavailable')
      }
    },
    chat: (bot, sessionId) => {
      const records = readAgentSessionRecordStore()
      const record = records?.getRecord(sessionId)
      if (!records || !record) {
        return null
      }
      // The same check the bot's chat list uses for a closed chat, for this one chat.
      const reach = structuredSessionMailReach(records, record, runtime.getOrchestrationDb())
      if (reach.kind === 'ended') {
        return null
      }
      const live = reach.kind === 'reachable' ? reach.session : record
      const home = bot.chatSessionId !== null && liveSession(bot.chatSessionId) === live.sessionId
      const linked = [sessionId, live.sessionId].some(
        (id) => findLinksForSession(store, id).length > 0
      )
      return {
        // A wake or any later write counts: it only ever keeps the chat open longer.
        lastActivityAt: Math.max(live.lastTurn?.at ?? 0, live.updatedAt),
        kept: home || linked || reach.kind !== 'reachable'
      }
    },
    busy: async (bot, sessionId) => {
      const live = liveSession(sessionId)
      return (
        botTurns.running(live) ||
        // Open on a screen, or in a tab: closing would take it away from whoever has it up.
        getStructuredAgentSessionHost()?.reads.viewed(live) === true ||
        getStructuredAgentSessionHost()?.isSessionTabVisible(live) === true ||
        (await runtime.botItems.chatHasOpenItems(bot.id, sessionId))
      )
    },
    close: async (sessionId) =>
      (
        await closeBotSession(runtime, liveSession(sessionId), {
          admitClose: (work) => work.state === 'idle'
        })
      ).stopped
  })
  store.onSettingsChanged(() => closer.settingsChanged())
  runtime.onBotsWritten(() => closer.settingsChanged())
  closer.rearm()
  return closer
}
