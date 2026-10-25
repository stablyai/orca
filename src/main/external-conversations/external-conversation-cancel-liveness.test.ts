import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_SETTLE_TIMEOUT_MS } from './external-conversation-cancel'
import { ConversationChain } from './external-conversation-chain'
import { deferred, harness } from './external-conversation-seam.test-fixture'
import {
  fakeLauncher,
  fakeTerminal,
  launchResult,
  PANE,
  SESSION,
  WORKTREE
} from './external-conversation.test-fixture'
import type { Delivery } from './external-conversation-types'

const KEY = { source: 'dev', externalId: 'cancel-liveness' } as const
const START = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: `id:${WORKTREE}` },
  prompt: 'first'
}
const UNREACHABLE = { outcome: 'refused', reason: 'agent_not_reachable' }
const CANCELLED = { outcome: 'refused', reason: 'conversation_cancelled' } as const

afterEach(() => vi.useRealTimers())

describe('cancel settlement liveness', () => {
  it('refuses a stuck link lookup, preserves retries, and stops the agent once linked', async () => {
    const h = harness()
    const fake = fakeTerminal()
    const linking = deferred<{ worktreeId: string; sshHostId: null }>()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const host = {
      launcher: { ...launcher, paneWorkspace: () => linking.promise },
      terminal: fake.terminal
    }
    const started = h.seam.start(host, KEY, 'start', START)
    const queued = h.seam.send(host, KEY, 'queued', 'queued')
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    h.hookRows.set(PANE, {
      state: 'working',
      prompt: '',
      agentType: 'claude',
      paneKey: PANE,
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 100
    })
    vi.useFakeTimers()
    const cancel = h.seam.cancel(host, KEY, 'cancel')
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS)
    await expect(cancel).resolves.toEqual(UNREACHABLE)
    await expect(queued).resolves.toEqual(CANCELLED)
    await expect(h.seam.send(host, KEY, 'new', 'new')).resolves.toEqual(CANCELLED)
    const retry = h.seam.cancel(host, KEY, 'cancel')
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS)
    await expect(retry).resolves.toEqual(UNREACHABLE)
    expect(fake.keys).toEqual([])
    linking.resolve({ worktreeId: WORKTREE, sshHostId: null })
    await started
    await expect(h.seam.cancel(host, KEY, 'cancel')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
    expect(fake.writes).toEqual([])
  })

  it('does not accept a published launch whose link fails', async () => {
    const h = harness()
    const linking = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const host = {
      launcher: {
        ...launcher,
        paneWorkspace: async () => {
          await linking.promise
          throw new Error('host_disconnected')
        }
      },
      terminal: fakeTerminal().terminal
    }
    const started = h.seam.start(host, KEY, 'start', START)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    const cancel = h.seam.cancel(host, KEY, 'cancel')
    linking.resolve()
    await expect(cancel).resolves.toEqual(UNREACHABLE)
    await expect(started).resolves.toMatchObject({ initial: { outcome: 'unknown' } })
  })

  it('bounds an unpublished launch that ignores abort and respects disabling while waiting', async () => {
    const h = harness()
    const finishing = deferred<void>()
    const { launcher, launch } = fakeLauncher(
      async () => {
        await finishing.promise
        throw new Error('request_aborted')
      },
      undefined,
      false
    )
    const host = { launcher, terminal: fakeTerminal().terminal }
    const started = h.seam.start(host, KEY, 'start', START)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    const cancel = h.seam.cancel(host, KEY, 'cancel')
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS)
    await expect(cancel).resolves.toEqual(UNREACHABLE)
    const retry = h.seam.cancel(host, KEY, 'cancel')
    h.seam.dispose('connectors_disabled')
    await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS)
    await expect(retry).resolves.toEqual({ outcome: 'refused', reason: 'connectors_disabled' })
    finishing.resolve()
    await expect(started).resolves.toMatchObject({ initial: CANCELLED })
  })

  it.each(['write', 'reopen', 'readiness'] as const)(
    'bounds a stuck %s without accepting cancellation',
    async (stage) => {
      const fake = fakeTerminal()
      const h = harness({}, undefined, undefined, fake.terminal)
      const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'))
      const host = { launcher, terminal: fake.terminal }
      await h.seam.start(host, KEY, 'start', START)
      const blocked = deferred<void>()
      const entered = deferred<void>()
      const failAfterRelease = async (): Promise<never> => {
        entered.resolve()
        await blocked.promise
        throw new Error('request_aborted')
      }
      if (stage === 'write') {
        fake.sendTerminalAgentPrompt.mockImplementationOnce(failAfterRelease)
      } else {
        h.reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
        fake.exit()
        fake.reopenable()
        if (stage === 'reopen') {
          fake.resumeAgentSessionInWorkspace.mockImplementationOnce(failAfterRelease)
        } else {
          fake.waitForFreshWorkerComposer.mockImplementationOnce(failAfterRelease)
        }
      }
      const send = h.seam.send(host, KEY, 'send', 'held')
      await entered.promise
      vi.useFakeTimers()
      const cancel = h.seam.cancel(host, KEY, 'cancel')
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_TIMEOUT_MS)
      await expect(cancel).resolves.toEqual(UNREACHABLE)
      await expect(h.seam.send(host, KEY, 'later', 'later')).resolves.toEqual(CANCELLED)
      expect(fake.keys).toEqual([])
      expect(fake.writes).toEqual([])
      blocked.resolve()
      await send.catch(() => undefined)
    }
  )

  it('keeps a cancelled head until it finishes even when queued work has already refused', async () => {
    const chain = new ConversationChain(new AbortController().signal)
    const head = deferred<Delivery>()
    const running = vi.fn(() => head.promise)
    const first = chain.enqueue('lane', running)
    const follower = vi.fn(async (): Promise<Delivery> => ({ outcome: 'accepted' }))
    const queued = chain.enqueue('lane', follower)
    await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(1))
    const settling = chain.cancel('lane', 'conversation_cancelled')
    await expect(queued).resolves.toEqual(CANCELLED)
    await expect(chain.enqueue('lane', follower)).resolves.toEqual(CANCELLED)
    expect(chain.cancel('lane', 'conversation_cancelled')).not.toBeNull()
    expect(follower).not.toHaveBeenCalled()
    head.resolve({ outcome: 'unknown', reason: 'writer_failed' })
    await first
    await expect(settling).resolves.toBe(false)
    await expect(chain.enqueue('lane', follower)).resolves.toEqual({ outcome: 'accepted' })
  })
})
