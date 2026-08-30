import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { normalizeAgentStatusPayload } from '../shared/agent-status-types'
import {
  isAgentHookSource,
  type AgentHookRelayEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import { parsePaneKey } from '../shared/stable-pane-id'
import { normalizeAgentProviderSession } from '../shared/agent-session-resume'
import { normalizeAgentReconcileDiagnostic } from '../shared/agent-reconcile-diagnostic'

export type RelayHookStatusMeta = {
  source: AgentHookSource
  env?: string
  version?: string
  receivedAt?: number
}
type PersistedCache = {
  version: number
  entries: { event: AgentHookEventPayload; meta: RelayHookStatusMeta }[]
}

const CACHE_VERSION = 1
const MAX_CACHED_PANES = 256
const MAX_RECONCILE_ATTEMPTS = 5
const RECONCILE_INTERVAL_MS = 1_000
const RECONCILE_YIELD_MS = 25

function sanitizeHydratedEntry(
  rawEntry: unknown
): { event: AgentHookEventPayload; meta: RelayHookStatusMeta } | null {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const entry = rawEntry as Record<string, unknown>
  if (typeof entry.event !== 'object' || entry.event === null) {
    return null
  }
  if (typeof entry.meta !== 'object' || entry.meta === null) {
    return null
  }
  const rawEvent = entry.event as Record<string, unknown>
  const paneKey = rawEvent.paneKey
  if (typeof paneKey !== 'string' || !parsePaneKey(paneKey)) {
    return null
  }
  const payload = normalizeAgentStatusPayload(rawEvent.payload)
  // Every normalized hook event carries its source agent type. Without it,
  // restart reconciliation and replay would operate on an untrusted shape.
  if (!payload || typeof payload.agentType !== 'string' || payload.agentType.length === 0) {
    return null
  }
  const rawMeta = entry.meta as Record<string, unknown>
  if (!isAgentHookSource(rawMeta.source)) {
    return null
  }
  if (
    (rawMeta.env !== undefined && typeof rawMeta.env !== 'string') ||
    (rawMeta.version !== undefined && typeof rawMeta.version !== 'string') ||
    (rawMeta.receivedAt !== undefined &&
      (typeof rawMeta.receivedAt !== 'number' || !Number.isFinite(rawMeta.receivedAt)))
  ) {
    return null
  }
  const providerSession =
    rawEvent.providerSession === undefined
      ? undefined
      : normalizeAgentProviderSession(rawEvent.providerSession)
  if (rawEvent.providerSession !== undefined && !providerSession) {
    return null
  }
  const reconcileDiagnostic = normalizeAgentReconcileDiagnostic(rawEvent.reconcileDiagnostic)
  if (rawEvent.reconcileDiagnostic !== undefined && reconcileDiagnostic === undefined) {
    return null
  }
  return {
    event: {
      ...rawEvent,
      paneKey,
      payload,
      ...(providerSession ? { providerSession } : {}),
      ...(reconcileDiagnostic !== undefined ? { reconcileDiagnostic } : {})
    } as AgentHookEventPayload,
    meta: {
      source: rawMeta.source,
      env: typeof rawMeta.env === 'string' ? rawMeta.env : undefined,
      version: typeof rawMeta.version === 'string' ? rawMeta.version : undefined,
      receivedAt: typeof rawMeta.receivedAt === 'number' ? rawMeta.receivedAt : undefined
    }
  }
}

export function applyRelayHookEvent(options: {
  state: HookListenerState
  event: AgentHookEventPayload
  previous: AgentHookEventPayload | undefined
  source: AgentHookSource
  env?: string
  version?: string
  receivedAt?: number
  metadata: Map<string, RelayHookStatusMeta>
  persist: () => void
  clearPaneState: (paneKey: string) => void
  forward: (envelope: AgentHookRelayEnvelope) => void
}): void {
  const diagnosticAwareEvent =
    options.event.payload.agentType === 'codex' && options.event.hookEventName === 'SessionStart'
      ? { ...options.event, reconcileDiagnostic: null }
      : options.event
  const cachedEvent = diagnosticAwareEvent
  options.state.lastStatusByPaneKey.delete(diagnosticAwareEvent.paneKey)
  options.state.lastStatusByPaneKey.set(diagnosticAwareEvent.paneKey, cachedEvent)
  options.metadata.set(diagnosticAwareEvent.paneKey, {
    source: options.source,
    env: options.env,
    version: options.version,
    receivedAt: options.receivedAt ?? Date.now()
  })
  options.persist()
  while (options.state.lastStatusByPaneKey.size > MAX_CACHED_PANES) {
    const oldest = options.state.lastStatusByPaneKey.keys().next().value
    if (oldest === undefined) {
      break
    }
    options.clearPaneState(oldest)
  }
  options.forward(buildRelayHookEnvelope(cachedEvent, options.source, options.env, options.version))
}

export function hydrateRelayHookStatusCache(
  filePath: string,
  state: HookListenerState,
  onCodex: (paneKey: string) => void
): Map<string, RelayHookStatusMeta> {
  const metadata = new Map<string, RelayHookStatusMeta>()
  if (!existsSync(filePath)) {
    return metadata
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return metadata
  }
  if (!parsed || typeof parsed !== 'object') {
    return metadata
  }
  const cache = parsed as Partial<PersistedCache>
  if (cache.version !== CACHE_VERSION || !Array.isArray(cache.entries)) {
    return metadata
  }
  for (const rawEntry of cache.entries.slice(-MAX_CACHED_PANES)) {
    const entry = sanitizeHydratedEntry(rawEntry)
    if (!entry) {
      continue
    }
    const event = entry.event
    state.lastStatusByPaneKey.set(event.paneKey, event)
    metadata.set(event.paneKey, entry.meta)
    if (event.payload.agentType === 'codex') {
      onCodex(event.paneKey)
    }
  }
  return metadata
}

export function persistRelayHookStatusCache(
  endpointDir: string,
  filePath: string,
  state: HookListenerState,
  metadata: ReadonlyMap<string, RelayHookStatusMeta>
): void {
  try {
    mkdirSync(endpointDir, { recursive: true })
    const entries: PersistedCache['entries'] = []
    for (const [paneKey, event] of state.lastStatusByPaneKey) {
      const meta = metadata.get(paneKey)
      if (meta) {
        entries.push({ event, meta })
      }
    }
    const temporary = `${filePath}.tmp-${process.pid}`
    writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8')
    renameSync(temporary, filePath)
  } catch (err) {
    process.stderr.write(
      `[relay-hook-server] status cache persistence failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}

export function scheduleRelayCodexReconciliation(options: {
  paneKey: string
  state: HookListenerState
  isListening: () => boolean
  timers: Map<string, ReturnType<typeof setTimeout>>
  reconcile: (event: AgentHookEventPayload) => AgentHookEventPayload
  metadata: ReadonlyMap<string, RelayHookStatusMeta>
  forward: (envelope: AgentHookRelayEnvelope) => void
  persist: () => void
  gate: { nextRunAt: number }
  isReplay?: boolean
  attempt?: number
  delayMs?: number
}): void {
  const prior = options.timers.get(options.paneKey)
  if (prior) {
    clearTimeout(prior)
  }
  const timer = setTimeout(() => {
    options.timers.delete(options.paneKey)
    const gateDelay = options.gate.nextRunAt - Date.now()
    if (gateDelay > 0) {
      scheduleRelayCodexReconciliation({ ...options, delayMs: gateDelay })
      return
    }
    if (!options.isListening()) {
      return
    }
    const current = options.state.lastStatusByPaneKey.get(options.paneKey)
    if (!current || current.payload.agentType !== 'codex') {
      return
    }
    const next = options.reconcile(current)
    options.gate.nextRunAt = Date.now() + RECONCILE_YIELD_MS
    const transcript = options.state.codexSubagentTranscriptByPaneKey.get(options.paneKey)
    const attempt = options.attempt ?? 0
    const unreadable =
      attempt + 1 >= MAX_RECONCILE_ATTEMPTS &&
      (!current.providerSession?.transcriptPath ||
        transcript?.parentReadable === false ||
        Boolean(
          transcript && [...transcript.subagents.values()].some((child) => child.unresolvedSince)
        ))
    const updated = unreadable
      ? {
          ...next,
          reconcileDiagnostic: {
            kind: 'unverifiable' as const,
            reason: 'transcript-unreadable' as const,
            observedAt: Date.now()
          }
        }
      : next
    if (JSON.stringify(updated) !== JSON.stringify(current)) {
      options.state.lastStatusByPaneKey.set(options.paneKey, updated)
      options.persist()
      const meta = options.metadata.get(options.paneKey)
      if (meta) {
        const envelope = buildRelayHookEnvelope(updated, meta.source, meta.env, meta.version)
        options.forward(options.isReplay ? { ...envelope, isReplay: true } : envelope)
      }
    }
    if (!unreadable && attempt + 1 < MAX_RECONCILE_ATTEMPTS) {
      scheduleRelayCodexReconciliation({
        ...options,
        attempt: attempt + 1,
        delayMs: RECONCILE_INTERVAL_MS
      })
    }
  }, options.delayMs ?? RECONCILE_INTERVAL_MS)
  options.timers.set(options.paneKey, timer)
  if (typeof timer.unref === 'function') {
    timer.unref()
  }
}

export function createRelayCodexReconciler(
  options: Omit<Parameters<typeof scheduleRelayCodexReconciliation>[0], 'paneKey' | 'attempt'>
): (paneKey: string) => void {
  return (paneKey) => scheduleRelayCodexReconciliation({ ...options, paneKey })
}
