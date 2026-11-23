// Each bot's Google setup run as the chat's setup cards read it: one read per bot however many cards
// it has, again on the host's settings notice (sent on every run change), a reconnect or the foreground.
import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import type {
  GoogleSetupAction,
  GoogleSetupBlocker
} from '../../../../../../src/shared/google/google-setup-blocker'
import type {
  GoogleSetupCard,
  GoogleSetupRun
} from '../../../../../../src/shared/google/google-setup-run'
import { startHostBotRefresh } from '../../../../bots/host-bot-refresh'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { googleSetupAnswer, googleSetupRead } from './mobile-bot-card-operations'

export type MobileGoogleSetup = { run: GoogleSetupRun | null; blocker: GoogleSetupBlocker | null }

type Reading = { run: GoogleSetupRun | null; blocker?: unknown }

type Entry = {
  /** Held only while a card shows, so a closed or replaced client isn't kept for the app's life. */
  client: RpcClient | null
  botId: string
  setup: MobileGoogleSetup | null
  readers: number
  /** Stops the re-reads; null while no card shows. */
  stop: (() => void) | null
  /** The host answered once, even with a reply this build can't read; notices re-read after that. */
  replied: boolean
  /** Every run id read or asked for, so a card from an unseen run reads once, not on every mount. */
  known: Set<string>
  /** Raised per request; a reply older than the last one applied is dropped. */
  asked: number
  applied: number
  /** Raised when the last card leaves; a read from an earlier showing is dropped. */
  showing: number
}

// Every kind and button this build words; a Record so a new one on the type fails the typecheck here.
const BLOCKER_KINDS: Record<GoogleSetupBlocker['kind'], true> = {
  stopped: true,
  paused: true,
  'needs-user': true,
  'no-key': true,
  'key-gone': true,
  'key-other-project': true,
  'other-account': true,
  'signed-out': true,
  'needs-permission': true,
  'api-off': true,
  'admin-blocked': true,
  'check-failed': true
}

const ACTION_IDS: Record<GoogleSetupAction['id'], true> = {
  'make-new-key': true,
  'import-key': true,
  allow: true,
  'continue-without': true,
  'keep-account': true,
  'sign-in-again': true,
  'turn-on': true,
  'copy-for-admin': true,
  'check-again': true,
  continue: true,
  'start-over': true,
  'let-me': true,
  done: true
}

const known = (table: Readonly<Record<string, true>>, value: unknown): boolean =>
  Object.hasOwn(table, String(value))

function isAction(value: unknown): value is GoogleSetupAction {
  return typeof value === 'object' && value !== null && 'id' in value && known(ACTION_IDS, value.id)
}

function isBlocker(value: unknown): value is GoogleSetupBlocker {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    known(BLOCKER_KINDS, value.kind) &&
    'actions' in value &&
    Array.isArray(value.actions)
  )
}

/** A newer host's blocker this build can't word reads as none, and its unknown buttons are left off. */
function knownBlocker(blocker: unknown): GoogleSetupBlocker | null {
  return isBlocker(blocker) ? { ...blocker, actions: blocker.actions.filter(isAction) } : null
}

// By `hostKey` and bot id.
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

const keyOf = (hostKey: string, botId: string): string => `${hostKey}\u0000${botId}`

const sameSetup = (a: MobileGoogleSetup | null, b: MobileGoogleSetup): boolean =>
  a !== null &&
  a.run?.id === b.run?.id &&
  a.run?.revision === b.run?.revision &&
  JSON.stringify(a.blocker) === JSON.stringify(b.blocker)

/** Applies a reply to the entry that asked, unless it was replaced since or a later reply is in. */
function apply(key: string, entry: Entry, ticket: number, reading: Reading): void {
  if (entries.get(key) !== entry || ticket < entry.applied) {
    return
  }
  entry.applied = ticket
  if (reading.run) {
    entry.known.add(reading.run.id)
  }
  const setup = { run: reading.run, blocker: knownBlocker(reading.blocker) }
  if (sameSetup(entry.setup, setup)) {
    return
  }
  entry.setup = setup
  for (const listener of listeners) {
    listener()
  }
}

function read(key: string): void {
  const entry = entries.get(key)
  if (!entry?.client) {
    return
  }
  const ticket = ++entry.asked
  const showing = entry.showing
  void googleSetupRead
    .request(entry.client, { botId: entry.botId })
    .then((response) => {
      if (entry.showing !== showing) {
        return
      }
      entry.replied = true
      apply(key, entry, ticket, googleSetupRead.interpret(response))
    })
    // Unread, the card shows the host's line; the next notice reads again.
    .catch(() => {})
}

/** Re-reads while a card shows: on the host's notices, a reconnect and the foreground. */
function startRefresh(key: string, entry: Entry, client: RpcClient): () => void {
  return startHostBotRefresh({
    client,
    appState: AppState,
    refresh: () => read(key),
    listed: () => entry.replied,
    // As the computer's cards: a run change is a settings notice, a bot edit a bot one.
    interest: () => ({ botId: entry.botId, kinds: ['settings', 'bot'] })
  })
}

/** The setup outlives the last card, so scrolling one back shows it at once; it reads again then. */
function attach(key: string, client: RpcClient, botId: string): () => void {
  let entry = entries.get(key)
  if (entry?.client && entry.client !== client) {
    entry.stop?.()
    entries.delete(key)
    entry = undefined
  }
  if (!entry) {
    entry = {
      client,
      botId,
      setup: null,
      replied: false,
      readers: 0,
      stop: null,
      known: new Set(),
      asked: 0,
      applied: 0,
      showing: 0
    }
    entries.set(key, entry)
  }
  const attached = entry
  attached.client = client
  attached.readers += 1
  attached.stop ??= startRefresh(key, attached, client)
  return () => {
    attached.readers -= 1
    if (attached.readers === 0) {
      attached.stop?.()
      attached.stop = null
      attached.client = null
      // The next showing may read through another client; it waits for that client's own reply.
      attached.replied = false
      attached.showing += 1
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The bot's setup run and where it's stuck; null until read. A card from a run this phone hasn't
 *  seen (a setup started since) reads again. */
export function useMobileGoogleSetup(
  client: RpcClient | null,
  hostKey: string | null,
  botId: string,
  runId: string
): MobileGoogleSetup | null {
  const key = hostKey ? keyOf(hostKey, botId) : null
  useEffect(() => (client && key ? attach(key, client, botId) : undefined), [client, key, botId])
  const setup = useSyncExternalStore(
    subscribe,
    () => (key ? entries.get(key)?.setup : null) ?? null
  )
  const loaded = setup !== null
  useEffect(() => {
    const entry = key ? entries.get(key) : undefined
    if (!key || !entry || !loaded || entry.known.has(runId)) {
      return
    }
    entry.known.add(runId)
    read(key)
  }, [key, loaded, runId])
  return setup
}

/** Records the owner's answer and tells the bot, with no message in the chat. */
export async function answerMobileGoogleSetup(
  client: RpcClient,
  hostKey: string,
  botId: string,
  card: GoogleSetupCard,
  values: string[]
): Promise<void> {
  const key = keyOf(hostKey, botId)
  const entry = entries.get(key)
  const ticket = entry ? ++entry.asked : 0
  const reading = googleSetupAnswer.interpret(
    await googleSetupAnswer.request(client, { botId, card, values })
  )
  if (entry) {
    apply(key, entry, ticket, reading)
  }
}
