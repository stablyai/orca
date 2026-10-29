import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type StructuredSubjectRead = {
  sessionId: string
  target: RuntimeClientTarget
  observedCursor: AgentJournalCursor
  observationKey: string
}
export type AgentSubjectRead = { subjectKey: string; structured?: StructuredSubjectRead }
/** `explicit`: the user marked the row read without viewing it (Activity, dashboard, a jump). */
export type AgentSubjectReadIntent = 'view' | 'explicit'

type AgentSubjectReadListener = (
  reads: readonly AgentSubjectRead[],
  readsBySubjectKey: ReadonlyMap<string, AgentSubjectRead>
) => void

const captures = new Map<string, (intent: AgentSubjectReadIntent) => StructuredSubjectRead | null>()
const listeners = new Set<AgentSubjectReadListener>()
const viewListeners = new Set<(read: StructuredSubjectRead) => void>()

export function registerAgentSubjectReadCapture(
  subjectKey: string,
  capture: (intent: AgentSubjectReadIntent) => StructuredSubjectRead | null
): () => void {
  captures.set(subjectKey, capture)
  return () => {
    if (captures.get(subjectKey) === capture) {
      captures.delete(subjectKey)
    }
  }
}

export function captureAgentSubjectReads(
  subjectKeys: readonly string[],
  intent: AgentSubjectReadIntent = 'view'
): AgentSubjectRead[] {
  return subjectKeys.map((subjectKey) => {
    try {
      const structured = captures.get(subjectKey)?.(intent)
      return { subjectKey, ...(structured ? { structured } : {}) }
    } catch (error) {
      console.warn('[agent-subject-read] could not capture accepted view', error)
      return { subjectKey }
    }
  })
}

export function emitAgentSubjectReads(
  subjectKeys: readonly string[],
  captured?: readonly AgentSubjectRead[],
  intent: AgentSubjectReadIntent = 'view'
): void {
  const reads =
    captured === undefined
      ? captureAgentSubjectReads(subjectKeys, intent)
      : captured.filter((read) => subjectKeys.includes(read.subjectKey))
  if (listeners.size === 0) {
    return
  }
  const readsBySubjectKey = new Map<string, AgentSubjectRead>()
  for (const read of reads) {
    const subjectKey = read.subjectKey
    if (!readsBySubjectKey.has(subjectKey)) {
      readsBySubjectKey.set(subjectKey, read)
    }
  }
  for (const listener of listeners) {
    try {
      listener(reads, readsBySubjectKey)
    } catch (error) {
      console.warn('[agent-subject-read] retirement failed', error)
    }
  }
}

export function subscribeAgentSubjectReads(listener: AgentSubjectReadListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyStructuredAttentionView(read: StructuredSubjectRead): void {
  for (const listener of viewListeners) {
    try {
      listener(read)
    } catch (error) {
      console.warn('[agent-subject-read] view evaluation failed', error)
    }
  }
}

export function subscribeStructuredAttentionViews(
  listener: (read: StructuredSubjectRead) => void
): () => void {
  viewListeners.add(listener)
  return () => {
    viewListeners.delete(listener)
  }
}

export function sameStructuredReadTarget(
  left: RuntimeClientTarget,
  right: RuntimeClientTarget
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'local' ||
      (right.kind === 'environment' && left.environmentId === right.environmentId))
  )
}
