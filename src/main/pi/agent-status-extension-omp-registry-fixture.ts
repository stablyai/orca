import type { AgentSubagentSnapshot } from '../../shared/agent-status-types'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

export const NATIVE_TIME = 1_791_947_032_900

type NativeSession = {
  sessionManager: {
    getSessionId: () => string
    getSessionFile: () => string
    getHeader: () => { id: string; parentSession?: string }
  }
  isStreaming: boolean
  hasPendingAsyncWork?: () => boolean
}

export type NativeRef = {
  id: string
  displayName: string
  kind: 'main' | 'sub' | 'advisor'
  parentId?: string
  status: string
  session: NativeSession | null
  sessionFile: string
  createdAt: number
  history?: { agent: string }
  lifecycle?: { acceptedAt?: number; terminalAt?: number }
}

type NativeChange = {
  type: 'registered' | 'status_changed' | 'metadata_changed' | 'removed'
  ref: NativeRef
}

type PostedOmpPayload = Record<string, unknown> & {
  hook_event_name: string
  omp_status?: Record<string, unknown>
  subagents?: AgentSubagentSnapshot[]
}

export type DeliveredPost = { payload: PostedOmpPayload; observedAt: number }
export type NativeDeliveryResponse = { ok: boolean; status?: number }

function nativeSession(
  identity: { id: string; file: string; parentSession?: string },
  isStreaming: boolean
): NativeSession {
  return {
    sessionManager: {
      getSessionId: () => identity.id,
      getSessionFile: () => identity.file,
      getHeader: () => ({ id: identity.id, parentSession: identity.parentSession })
    },
    isStreaming
  }
}

export type NativeRoot = {
  ref: NativeRef & { session: NativeSession }
  session: NativeSession
  file: string
  context: HookContext
  replaceSession: (id: string, parentSession?: string, sessionFile?: string) => void
}

export function nativeRoot(id = 'root-session', isStreaming = false): NativeRoot {
  const identity: { id: string; file: string; parentSession?: string } = {
    id,
    file: `/sessions/${id}.jsonl`
  }
  const session = nativeSession(identity, isStreaming)
  const ref: NativeRef & { session: NativeSession } = {
    id: 'Main',
    displayName: 'Main',
    kind: 'main',
    status: 'running',
    session,
    sessionFile: identity.file,
    createdAt: NATIVE_TIME - 127
  }
  return {
    ref,
    session,
    context: {
      agent: { id: 'Main', kind: 'main', depth: 0 },
      sessionManager: session.sessionManager,
      isIdle: () => !session.isStreaming
    },
    get file() {
      return identity.file
    },
    replaceSession(nextId: string, parentSession?: string, sessionFile?: string) {
      identity.id = nextId
      identity.file = sessionFile ?? `/sessions/${nextId}.jsonl`
      identity.parentSession = parentSession
      ref.sessionFile = identity.file
      session.isStreaming = false
    }
  }
}

export function nativeChild(
  id: string,
  rootFile: string,
  createdAt = NATIVE_TIME - 47,
  sessionId = `${id}-session`
): NativeRef & { session: NativeSession } {
  const sessionFile = `${rootFile.slice(0, -6)}/${id}.jsonl`
  return {
    id,
    displayName: 'registry-proof',
    kind: 'sub',
    parentId: 'Main',
    status: 'running',
    session: nativeSession({ id: sessionId, file: sessionFile, parentSession: rootFile }, true),
    sessionFile,
    createdAt,
    history: { agent: 'registry-proof' }
  }
}

export function createNativeFixture(
  root: NativeRoot,
  children: NativeRef[],
  options: {
    runtime?: { kind: 'omp' | 'pi'; title?: string; argv?: readonly string[] }
    env?: Record<string, string | undefined>
    delivery?: (payload: PostedOmpPayload) => Promise<NativeDeliveryResponse>
  } = {}
) {
  const refs = new Map<string, NativeRef>([root.ref, ...children].map((ref) => [ref.id, ref]))
  const listeners = new Set<(event: NativeChange) => void>()
  const delivered: DeliveredPost[] = []
  const accepted: DeliveredPost[] = []
  let listFailure: Error | undefined
  const registry = {
    list: () => {
      if (listFailure) {
        throw listFailure
      }
      return [...refs.values()]
    },
    get: (id: string) => refs.get(id),
    onChange: (listener: (event: NativeChange) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const harness = createAgentStatusExtensionHarness({
    ...(options.runtime ?? { kind: 'omp' }),
    env: options.env,
    nativeExtensionNamespace: { MAIN_AGENT_ID: 'Main', AgentRegistry: { global: () => registry } },
    fetchImpl: async (_url, init) => {
      const post: DeliveredPost = {
        payload: JSON.parse(String(init?.body)).payload,
        observedAt: Date.now()
      }
      delivered.push(post)
      const response = await (options.delivery?.(post.payload) ?? { ok: true })
      if (response.ok) {
        accepted.push({ ...post, observedAt: Date.now() })
      }
      return response
    }
  })
  const notify = (type: NativeChange['type'], ref: NativeRef): void => {
    listeners.forEach((listener) => listener({ type, ref }))
  }
  return {
    harness,
    refs,
    delivered,
    accepted,
    notify,
    failList: (error?: Error) => {
      listFailure = error
    },
    setStatus: (ref: NativeRef, status: 'idle' | 'aborted' | 'running') => {
      if (ref.status === 'aborted' || ref.status === status) {
        return
      }
      if (status === 'running') {
        ref.lifecycle = undefined
      } else if (ref.status === 'running') {
        // The SDK stamps terminalAt even for an idle pause with pending async work.
        ref.lifecycle = { ...ref.lifecycle, terminalAt: Date.now() }
      }
      ref.status = status
      if (status === 'aborted') {
        ref.session = null
      } else if (status === 'idle' && ref.session) {
        ref.session.isStreaming = false
      }
      notify('status_changed', ref)
    },
    captureNotification: () => {
      const dispatched = [...listeners]
      return (type: NativeChange['type'], ref: NativeRef) =>
        dispatched.forEach((listener) => listener({ type, ref }))
    }
  }
}
