// Tells the host's clients a sign-in's shown state changed (signed in or out, lost, why it couldn't
// start), so every window and phone reads the bot's tools again. A refreshed token changes nothing shown.
import { resolve } from 'node:path'
import type { BotToolOAuthEntry } from './bot-tool-credentials'

type Shown = Pick<BotToolOAuthEntry, 'url' | 'grant' | 'record'> | null
/** `folder`: the resolved tools folder whose sign-in changed. */
type Listener = (folder: string) => void
const listeners = new Set<Listener>()

export function onBotToolSignInChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announceBotToolSignInChanged(folder: string): void {
  for (const listener of listeners) {
    try {
      listener(resolve(folder))
    } catch (error) {
      console.warn('[bot-tool-credentials] a sign-in change listener failed:', error)
    }
  }
}

/** What a row shows of a sign-in, without its tokens: a refresh alone leaves it the same. */
function shownState(entry: Shown): string {
  if (!entry) {
    return ''
  }
  const { tokens, lost, problem } = entry.record
  return JSON.stringify([
    entry.url,
    entry.grant,
    tokens ? (tokens.refresh_token ? 'renewable' : 'limited') : null,
    lost ?? null,
    problem ?? null
  ])
}

/** Announces a commit that changed what a row shows of the sign-in. */
export function announceIfShownChanged(folder: string, before: Shown, after: Shown): void {
  if (shownState(before) !== shownState(after)) {
    announceBotToolSignInChanged(folder)
  }
}
