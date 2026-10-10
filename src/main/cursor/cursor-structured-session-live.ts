import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { CursorSdkConnection } from './cursor-sdk-connection'
import type { CursorSdkImage, CursorSidecarEvent } from './cursor-sdk-protocol'
import type { CursorJournalTranslator, CursorTurn } from './cursor-structured-journal'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export type CursorLiveSession = {
  connection: CursorSdkConnection
  agentId: string
  fence: number
  spawnToken: string
  acquisitionGeneration: string
  options: Record<string, string>
  mode: 'agent' | 'plan'
  cwd: string
  translator: CursorJournalTranslator
  turn: CursorTurn | null
  runInFlight: boolean
  resolveRun: (() => void) | null
  runSettled: Promise<void>
  steerWait: ((outcome: 'complete_delivered' | 'revert_to_followup') => void) | null
  steerWaitId: number | null
  nextSteerId: number
  started: boolean
  closed: boolean
}

export function cursorProviderLink(
  agentId: string,
  fence: number,
  origin: AgentSessionProviderHandleLink['origin']
): AgentSessionProviderHandleLink {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'agent'
  return {
    linkId: `cursor-${fence}-${safe}`.slice(0, 128),
    handle: { transport: 'cursor-sdk', agent: 'cursor', nativeId: agentId },
    origin,
    mintedAtFence: fence,
    observedAt: Date.now()
  }
}

export function cursorMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

export async function cursorMessageImages(
  body: AgentJournalMessageItem
): Promise<{ images?: CursorSdkImage[] } | Record<string, never>> {
  const images: CursorSdkImage[] = []
  for (const block of body.blocks) {
    if (block.type !== 'image-ref') {
      continue
    }
    if (block.url) {
      images.push({ url: block.url })
      continue
    }
    if (!block.path) {
      continue
    }
    const data = (await readFile(block.path)).toString('base64')
    images.push({
      data,
      mimeType: IMAGE_MIME[extname(block.path).toLowerCase()] ?? 'application/octet-stream'
    })
  }
  return images.length > 0 ? { images } : {}
}

export function cursorAuthFailure(message: string, code: string | undefined): boolean {
  return (
    code === 'unauthenticated' || /auth|sign in|api key|unauthenticated|logged out/i.test(message)
  )
}

export function beginCursorRun(session: CursorLiveSession): void {
  session.runInFlight = true
  session.runSettled = new Promise((resolve) => {
    session.resolveRun = resolve
  })
}

const dispatchTails = new WeakMap<CursorLiveSession, Promise<unknown>>()

export function enqueueCursorDispatch<T>(
  session: CursorLiveSession,
  run: () => Promise<T>
): Promise<T> {
  const previous = dispatchTails.get(session) ?? Promise.resolve()
  const next = previous.then(run, run)
  dispatchTails.set(session, next)
  return next
}

export function steerCursorRun(
  session: CursorLiveSession,
  text: string
): Promise<'complete_delivered' | 'revert_to_followup'> {
  const id = session.nextSteerId + 1
  session.nextSteerId = id
  const outcome = new Promise<'complete_delivered' | 'revert_to_followup'>((resolve) => {
    session.steerWait = resolve
    session.steerWaitId = id
  })
  session.connection.send({ type: 'steer', text, id })
  return Promise.race([
    outcome,
    session.runSettled.then(() => {
      if (session.steerWaitId === id) {
        session.steerWait = null
        session.steerWaitId = null
      }
      return 'revert_to_followup' as const
    })
  ])
}

export function waitForCursorStart(
  session: CursorLiveSession,
  signal?: AbortSignal
): Promise<CursorSidecarEvent> {
  return new Promise((resolve, reject) => {
    let settled = false
    const stop = session.connection.onEvent((event) => {
      if (event.type === 'ready' || event.type === 'startupError' || event.type === 'exited') {
        finish(() => resolve(event))
      }
    })
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      stop()
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => {
      finish(() => reject(new Error('Cursor chat was closed while starting')))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function applyCursorSidecarEvent(
  sessionId: string,
  session: CursorLiveSession,
  event: CursorSidecarEvent,
  onEnded: ((event: StructuredAgentSessionLifecycleEvent) => void) | undefined
): void {
  if (event.type === 'ready') {
    session.agentId = event.agentId
    session.started = true
    session.translator.clearLogin()
  }
  if (event.type === 'loginUrl') {
    session.translator.loginUrl(event.url)
    return
  }
  if (event.type === 'steer') {
    if (session.steerWaitId !== event.id) {
      return
    }
    session.steerWait?.(event.outcome)
    session.steerWait = null
    session.steerWaitId = null
    return
  }
  if (
    session.turn &&
    (event.type === 'text' ||
      event.type === 'thinking' ||
      event.type === 'task' ||
      event.type === 'tool' ||
      event.type === 'usage' ||
      event.type === 'result')
  ) {
    session.translator.apply(session.turn, event)
  }
  if (event.type === 'result') {
    session.runInFlight = false
    session.resolveRun?.()
    session.resolveRun = null
  }
  if (event.type === 'exited' && session.started && !session.closed) {
    session.closed = true
    session.runInFlight = false
    session.resolveRun?.()
    onEnded?.({
      type: 'ended',
      sessionId,
      reason: 'Cursor sidecar exited',
      cause: 'unexpected-exit',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration
    })
  }
}

export async function closeCursorSession(session: CursorLiveSession): Promise<boolean> {
  session.closed = true
  try {
    session.connection.send({ type: 'dispose' })
  } catch {
    // stdin can already be closed when the sidecar exited on its own
  }
  return session.connection.close()
}
