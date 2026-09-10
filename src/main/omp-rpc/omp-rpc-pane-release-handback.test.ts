// XLR-R6-003 (cross-lab review): who finishes a pane's release once the
// renderer's bounded cleanup retries are spent. A pane closed or rebound during
// a healthy long turn has every attempt refused as fail-closed live work, and
// nothing else was left holding the obligation — so main re-attempts when the
// session's own frames say the turn settled.

import { describe, expect, it, vi } from 'vitest'
import type { OmpRpcClientEvent, OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { OmpRpcChatSession } from './omp-rpc-chat-session'
import type { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'
import type { OmpRpcOwnedSession } from './omp-rpc-session-owner'
import { releaseOmpRpcPaneWithHandback } from './omp-rpc-pane-release-handback'

const AGENT_END: OmpRpcClientEvent = { kind: 'agent-end', frame: { type: 'agent_end' } }
const RELEASE_RETRY_FRAME_KINDS: readonly OmpRpcClientEvent['kind'][] = [
  'agent-end',
  'turn-end',
  'prompt-result',
  'exit',
  'protocol-fault'
]

function isOmpRpcReleaseRetryFrameKind(kind: OmpRpcClientEvent['kind']): boolean {
  return RELEASE_RETRY_FRAME_KINDS.includes(kind)
}
const RESPAWN = { replacedPtyId: 'pty-1', cwd: '/work', sessionId: 'session-a' }

/** A real OmpRpcChatSession over a stub client, so the retained-frame replay
 *  the continuation must not spin on is the genuine one. */
function makeSession(): { session: OmpRpcChatSession; push: (event: OmpRpcClientEvent) => void } {
  const listeners = new Set<(event: OmpRpcClientEvent) => void>()
  const client = {
    getCommands: async () => [],
    setSubagentSubscription: async (level: unknown) => level,
    on: (listener: (event: OmpRpcClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: vi.fn()
  } as unknown as OmpSessionOwningRpcClient
  const owned = { client, owner: {} } as unknown as OmpRpcOwnedSession
  return {
    session: new OmpRpcChatSession(owned),
    // Iterated directly, exactly as the real client's fanout does: a listener
    // that unsubscribes mid-emit is dropped from the set safely.
    push: (event) => {
      for (const listener of listeners) {
        listener(event)
      }
    }
  }
}

const SESSION_FILE = '/sessions/a.jsonl'

/** A real session whose `command` send can be held open, so the settlement a
 *  local-only command reports — its round trip finishing, with no frame at all
 *  — is the genuine one. `getState` answers the SAME session file the session
 *  is bound to, which is exactly why reconciliation publishes nothing. */
function makeCommandSession(): {
  session: OmpRpcChatSession
  frames: OmpRpcClientEvent[]
  answerPrompt: () => void
} {
  const listeners = new Set<(event: OmpRpcClientEvent) => void>()
  let answerPrompt = (): void => undefined
  const answered = new Promise<void>((resolve) => {
    answerPrompt = () => resolve()
  })
  const client = {
    getCommands: async () => [],
    setSubagentSubscription: async (level: unknown) => level,
    on: (listener: (event: OmpRpcClientEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: async () => {
      await answered
      return { agentInvoked: false }
    },
    getState: async () => ({ sessionFile: SESSION_FILE, sessionId: 'session-a' }),
    dispose: vi.fn()
  } as unknown as OmpSessionOwningRpcClient
  const owned = { client, owner: {} } as unknown as OmpRpcOwnedSession
  const session = new OmpRpcChatSession(owned, SESSION_FILE)
  const frames: OmpRpcClientEvent[] = []
  session.on((event) => frames.push(event))
  return { session, frames, answerPrompt }
}

function makeRegistry(
  release: () => Promise<{ released: boolean; sessionId?: string }>,
  get: () => OmpRpcChatSession | null
): OmpRpcChatSessionRegistry {
  return { release, get } as unknown as OmpRpcChatSessionRegistry
}

describe('releaseOmpRpcPaneWithHandback', () => {
  it('finishes a refused release once the session reports the turn settled', async () => {
    const { session, push } = makeSession()
    const release = vi
      .fn()
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: true, sessionId: 'session-b' })
    const sendHandback = vi.fn()

    await expect(
      releaseOmpRpcPaneWithHandback({
        paneKey: 'tab:leaf',
        registry: makeRegistry(release, () => session),
        respawn: RESPAWN,
        sendHandback
      })
    ).resolves.toEqual({ released: false })
    // A fail-closed release keeps the claim, so it must never hand the PTY back.
    expect(sendHandback).not.toHaveBeenCalled()

    push(AGENT_END)
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    // The identity main proved at release time, not the caller's acquisition id.
    expect(sendHandback).toHaveBeenCalledWith({
      paneKey: 'tab:leaf',
      replacedPtyId: 'pty-1',
      cwd: '/work',
      sessionId: 'session-b'
    })
  })

  it('keeps re-attempting across several refusals, one per fresh settlement', async () => {
    const { session, push } = makeSession()
    const release = vi.fn().mockResolvedValue({ released: false })

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf',
      registry: makeRegistry(release, () => session),
      respawn: RESPAWN,
      sendHandback: vi.fn()
    })

    push(AGENT_END)
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    push(AGENT_END)
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3))
  })

  // The renderer's own retry bound exists because a protocol-faulted child
  // whose exit cannot be proven refuses forever. The session replays that
  // terminal frame to every new subscriber, so a re-arm acting on it would spin
  // release-plus-exit-proof cycles as fast as promises resolve.
  it('never spins on the terminal frame the session replays to a new subscriber', async () => {
    const { session, push } = makeSession()
    push({ kind: 'protocol-fault', message: 'transport died' })
    const release = vi.fn().mockResolvedValue({ released: false })

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf',
      registry: makeRegistry(release, () => session),
      respawn: RESPAWN,
      sendHandback: vi.fn()
    })

    // One continuation from the replay the FIRST arm is allowed to act on, and
    // then nothing until a genuinely new frame arrives.
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('uses a retained exit to retry after a refused release re-arms', async () => {
    const { session, push } = makeSession()
    const release = vi
      .fn()
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: true, sessionId: 'session-a' })

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf-retained-exit',
      registry: makeRegistry(release, () => session),
      respawn: RESPAWN,
      sendHandback: vi.fn()
    })
    push({ kind: 'exit', code: 0, signal: null })

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3))
  })

  it('never releases a pane a successor has since re-acquired', async () => {
    const { session, push } = makeSession()
    const successor = makeSession().session
    const release = vi.fn().mockResolvedValue({ released: false })
    let registered: OmpRpcChatSession = session

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf',
      registry: makeRegistry(release, () => registered),
      respawn: RESPAWN,
      sendHandback: vi.fn()
    })
    expect(release).toHaveBeenCalledTimes(1)

    registered = successor
    push(AGENT_END)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(release).toHaveBeenCalledTimes(1)
  })

  // Several refused releases in a row (the renderer's bounded cleanup) must
  // leave ONE listener: otherwise each wakes on the same settlement, joins
  // main's single-flight release, and pushes a hand-back of its own — several
  // `omp --resume` children launched against one session.
  it('arms one continuation per pane however many releases were refused', async () => {
    const { session, push } = makeSession()
    const release = vi
      .fn()
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValue({ released: true, sessionId: 'session-b' })
    const sendHandback = vi.fn()
    const registry = makeRegistry(release, () => session)

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf-one-arm',
      registry,
      respawn: RESPAWN,
      sendHandback
    })
    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf-one-arm',
      registry,
      respawn: RESPAWN,
      sendHandback
    })

    push(AGENT_END)
    await vi.waitFor(() => expect(sendHandback).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sendHandback).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(3)
  })

  // XLR-R7-002 (cross-lab review): release can be refused for command identity
  // ALONE, and a local-only slash or extension command reports its completion
  // through no frame — it runs no agent, and a read-back confirming the same
  // session publishes nothing either. Identity was then settled with main never
  // retrying, keeping the child, its claim, its session-file exclusion and the
  // pane's null PTY binding for the app's life.
  it('finishes a release refused on command identity when no frame ever reports it', async () => {
    const { session, frames, answerPrompt } = makeCommandSession()
    const release = vi
      .fn()
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: true, sessionId: 'session-a' })
    const sendHandback = vi.fn()
    const sending = session.send({ message: '/local-only', behavior: 'command' })

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf-command-settled',
      registry: makeRegistry(release, () => session),
      respawn: RESPAWN,
      sendHandback
    })
    expect(release).toHaveBeenCalledTimes(1)
    expect(sendHandback).not.toHaveBeenCalled()

    answerPrompt()
    await sending
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(sendHandback).toHaveBeenCalledWith({
      paneKey: 'tab:leaf-command-settled',
      replacedPtyId: 'pty-1',
      cwd: '/work',
      sessionId: 'session-a'
    })
    // Proof the frame path could not have woken it: the command emitted none of
    // the frames this continuation listens for.
    expect(frames.filter((frame) => isOmpRpcReleaseRetryFrameKind(frame.kind))).toEqual([])
  })

  // A prompt that started no agent turn reports its outcome through
  // `prompt_result` and no other frame, so nothing else speaks for it.
  it('finishes a refused release on a prompt-result frame', async () => {
    const { session, push } = makeSession()
    const release = vi
      .fn()
      .mockResolvedValueOnce({ released: false })
      .mockResolvedValueOnce({ released: true, sessionId: 'session-b' })

    await releaseOmpRpcPaneWithHandback({
      paneKey: 'tab:leaf-prompt-result',
      registry: makeRegistry(release, () => session),
      respawn: RESPAWN,
      sendHandback: vi.fn()
    })

    push({ kind: 'prompt-result', agentInvoked: false })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
  })

  it('pushes nothing when the caller asked for no respawn', async () => {
    const { session } = makeSession()
    const sendHandback = vi.fn()

    await expect(
      releaseOmpRpcPaneWithHandback({
        paneKey: 'tab:leaf',
        registry: makeRegistry(
          async () => ({ released: true, sessionId: 'session-b' }),
          () => session
        ),
        sendHandback
      })
    ).resolves.toEqual({ released: true })
    expect(sendHandback).not.toHaveBeenCalled()
  })
})
