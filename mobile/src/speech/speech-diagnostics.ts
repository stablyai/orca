import { useSyncExternalStore } from 'react'

/** What the reply reader last did, shown in Settings so a silent phone can be diagnosed. */
export type SpeechDiagnostics = {
  lastPollAt: number | null
  connectedHosts: number
  knownHosts: number
  agentRows: number
  newReplies: number
  lastSpokenAt: number | null
  lastError: string | null
  lastNewReplyAt: number | null
  /** The background service as last seen: running, off, stopped off screen, refused by Android… */
  service: string
  serviceStartedAt: number | null
  /** The service's last tick to reach JS; stale while the screen is off means ticks are lost. */
  lastTickAt: number | null
  /** The reader's latest steps, newest first, so a reply that went quiet midway can be traced. */
  events: readonly string[]
}

let diagnostics: SpeechDiagnostics = {
  lastPollAt: null,
  connectedHosts: 0,
  knownHosts: 0,
  agentRows: 0,
  newReplies: 0,
  lastSpokenAt: null,
  lastError: null,
  lastNewReplyAt: null,
  service: 'not started',
  serviceStartedAt: null,
  lastTickAt: null,
  events: []
}
const listeners = new Set<() => void>()

export function recordSpeechDiagnostics(patch: Partial<SpeechDiagnostics>): void {
  diagnostics = { ...diagnostics, ...patch }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const MAX_EVENTS = 15

export function logSpeechEvent(event: string): void {
  const line = `${new Date().toLocaleTimeString()} ${event}`
  recordSpeechDiagnostics({ events: [line, ...diagnostics.events].slice(0, MAX_EVENTS) })
}

export function useSpeechDiagnostics(): SpeechDiagnostics {
  return useSyncExternalStore(subscribe, () => diagnostics)
}

function clock(at: number | null): string {
  return at === null ? 'never' : new Date(at).toLocaleTimeString()
}

export function describeSpeechDiagnostics(d: SpeechDiagnostics): string {
  return [
    `Last check: ${clock(d.lastPollAt)}`,
    `Hosts connected: ${d.connectedHosts} of ${d.knownHosts}`,
    `Agents seen: ${d.agentRows}, new replies last check: ${d.newReplies}`,
    `Last new reply: ${clock(d.lastNewReplyAt)}`,
    `Last read aloud: ${clock(d.lastSpokenAt)}`,
    `Background service: ${d.service} (started ${clock(d.serviceStartedAt)}, last tick ${clock(d.lastTickAt)})`,
    `Last error: ${d.lastError ?? 'none'}`,
    'Reader log:',
    ...(d.events.length > 0 ? d.events : ['(empty)'])
  ].join('\n')
}
