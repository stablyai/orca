// The finished run chat closer on this host: its chat records, settings and the bot chat close.
import { readFile } from 'node:fs/promises'
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
import { readBotChats } from '../runtime/rpc/methods/bots-chats'
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
    path: () => join(getProfileUserDataPath(), 'bot-run-chat-close.json'),
    read: (path) => readFile(path, 'utf8').catch(() => null),
    write: (path, text) => writePluginFileAtomically(path, text, { mode: 0o600 }),
    now: () => Date.now(),
    bots: () => runtime.bots.list(),
    hostDefault: () => resolveHostOwnedSetting(store.getSettings(), 'botRunChatsCloseAfter'),
    chatsOf: async (bot) => {
      const rows = new Map(
        (await readBotChats(runtime, bot, null, true)).map((row) => [row.id, row])
      )
      return (sessionId) => {
        const row = rows.get(sessionId)
        if (!row || row.closed) {
          return null
        }
        const linked = [sessionId, liveSession(sessionId)].some(
          (id) => findLinksForSession(store, id).length > 0
        )
        return { lastActivityAt: row.lastActivityAt, kept: row.home || linked }
      }
    },
    lastActivityAt: (sessionId) => {
      const record = readAgentSessionRecordStore()?.getRecord(liveSession(sessionId))
      return record ? (record.lastTurn?.at ?? record.updatedAt) : null
    },
    busy: async (bot, sessionId) => {
      const live = liveSession(sessionId)
      return (
        botTurns.running(live) ||
        // Open in a tab: closing would take it away from whoever has it up.
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
