import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  dispatchClaudeTurn,
  retireClaudeDispatchWaiters
} from '../../../../../claude/structured/dispatch/claude-structured-dispatch'
import { retireWaiter } from '../../../../../claude/structured/dispatch/claude-structured-dispatch-waiters'
import type { ClaudeSession } from '../../../../../claude/structured/claude-structured-session-state'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  localReceiptProvider,
  providerHandoverReceipt
} from '../../../journal-ingress/provider-receipt-publication'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

const body: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

async function openJournal() {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, SESSION)
  })
}

const scope = { kind: 'thread' } as const

// PR #51346: retired waiter identities must have no outstanding reader associations.
it('detaches receipt callbacks while retaining late replay identity across 64 retirements', async () => {
  const journal = await openJournal()
  const subscribers = new AgentSessionSubscribers({ now: () => 100 })
  const registry = subscribers.providerReceipts
  journal.observeCommits((commit) => registry.observe(journal, commit))
  const frames = vi.fn()
  const reader = () =>
    subscribers.open({
      id: 'desktop',
      sessionId: SESSION,
      journal,
      fence: 1,
      readsProviderReceived: true,
      emit: frames
    })
  const idle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.waitFor(() => expect(subscribers.retention(new Set())).toEqual([]))
  }
  let close = reader()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses waiter state and its provider transport.
  const child = {
    providerSessionId: 'provider-1',
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    dispatchSequence: 0,
    connection: { send: async () => {} }
  } as unknown as ClaudeSession
  const begin = async (index: number) => {
    const clientMessageId = `send-${index}`
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: clientMessageId,
      body,
      fence: 1,
      handoverRecorded: true
    })
    subscribers.deliverFrames(SESSION, journal)
    await idle()
    const attempt = await journal.prepareHandover({
      clientMessageId,
      fence: 1,
      body,
      turnScope: scope,
      captureProviderReceipt: registry.hasLiveReader(journal)
    })
    const confirmation = registry.bind({
      journal,
      cursor: attempt.dispatchCursor!,
      clientMessageId,
      fence: 1,
      provider: 'claude',
      owns: () => true
    })
    expect(confirmation).toBeDefined()
    await dispatchClaudeTurn(child, {
      clientMessageId,
      sessionId: SESSION,
      body,
      beginProviderReceipt: () => confirmation
    })
    const waiter = child.dispatchWaiters[0]!
    expect(waiter.providerReceived).toBe(confirmation)
    const settle = () =>
      journal.resolveDispatch({
        clientMessageId,
        fence: 1,
        state: 'unknown',
        reason: 'provider ended'
      })
    return { confirmation, waiter, settle }
  }
  const pending = vi.fn(() => true)
  const noReaderWork = async (confirmation: Awaited<ReturnType<typeof begin>>['confirmation']) => {
    pending.mockClear()
    confirmation?.(pending)
    await idle()
    expect(pending).not.toHaveBeenCalled()
  }
  try {
    await idle()
    for (let index = 0; index < 64; index++) {
      const { confirmation, waiter, settle } = await begin(index)
      if (index === 0) {
        await settle()
        await noReaderWork(confirmation)
        close()
      } else if (index === 1) {
        close()
        await noReaderWork(confirmation)
        await settle()
      } else if (index === 2) {
        subscribers.snapshot(SESSION, journal, 1)
        await idle()
        await noReaderWork(confirmation)
        close()
        await settle()
      } else if (index === 3) {
        const disposed = close
        close = reader()
        disposed()
        await noReaderWork(confirmation)
        await settle()
      } else if (index === 4) {
        retireClaudeDispatchWaiters(child)
        await noReaderWork(confirmation)
        await settle()
      } else {
        await settle()
      }
      if (index !== 4) {
        retireWaiter(child, waiter)
      }
      expect(child.retiredDispatchWaiters.filter((entry) => entry.providerReceived)).toHaveLength(0)
      expect(child.retiredDispatchWaiters.at(-1)?.sentUuid).toBe(waiter.sentUuid)
      if (index < 3) {
        close = reader()
      }
      subscribers.deliverFrames(SESSION, journal)
      await idle()
    }
    expect(child.retiredDispatchWaiters).toHaveLength(64)
    const { confirmation } = await begin(64)
    confirmation?.(() => true)
    subscribers.deliverFrames(SESSION, journal)
    await idle()
    expect(frames.mock.calls.filter(([event]) => event.providerReceived)).toHaveLength(1)
  } finally {
    retireClaudeDispatchWaiters(child)
    close()
  }
})

// PR #51346: remote hosts skip both the receipt record read and the handover result lookup.
it.each(['phone-only', 'headless local', 'ssh', 'wsl'])(
  'keeps %s handover off the receipt capture path',
  async (host) => {
    const subscribers = new AgentSessionSubscribers()
    const location =
      host === 'ssh'
        ? { executionHostId: 'ssh:host' as const, wslDistro: null }
        : { executionHostId: 'local' as const, wslDistro: host === 'wsl' ? 'distro' : null }
    const provider = localReceiptProvider({
      provider: 'claude',
      location: { ...location, workspaceId: 'workspace', workspaceKind: 'git-worktree' }
    })
    const journal = await openJournal()
    const registry = subscribers.providerReceipts
    const wrappers = vi.spyOn(registry, 'track')
    const bind = vi.spyOn(registry, 'bind')
    const capture = vi.spyOn(journal, 'trackProviderReceiptSettlements')
    if (host !== 'headless local') {
      subscribers.open({
        id: host,
        sessionId: SESSION,
        journal,
        fence: 1,
        readsProviderReceived: host !== 'phone-only' && !!provider,
        emit: () => {}
      })
    }
    const commits: (number | undefined)[] = []
    journal.observeCommits((commit) => {
      commits.push(
        ...(commit.publication?.promptDispatches ?? []).map(
          (dispatch) => dispatch.previousHandoverSequence
        )
      )
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only these record fields.
    const readRecord = vi.fn(() => ({ location, provider: 'claude' }) as AgentSessionRecord)
    const receipt = providerHandoverReceipt(
      {
        sessionId: SESSION,
        journal,
        providerReceipts: subscribers.providerReceipts,
        fence: 1,
        record: readRecord,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: receipt eligibility never consults adapters or catalogs.
        adapter: {} as Parameters<typeof providerHandoverReceipt>[0]['adapter'],
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: receipt eligibility never consults adapters or catalogs.
        agents: {} as Parameters<typeof providerHandoverReceipt>[0]['agents'],
        childWork: () => [],
        childWorkOpen: () => false,
        now: () => 100
      },
      'send',
      () => true
    )
    expect(receipt).toBeUndefined()
    expect(readRecord).not.toHaveBeenCalled()
    await journal.appendSubmission({
      clientMessageId: 'send',
      payloadFingerprint: 'send',
      body,
      fence: 1,
      handoverRecorded: true
    })
    const attempt = await journal.prepareHandover({
      clientMessageId: 'send',
      fence: 1,
      body,
      turnScope: scope,
      captureProviderReceipt: !!receipt
    })
    await journal.resolveDispatch({
      clientMessageId: 'send',
      fence: 1,
      state: 'unknown',
      reason: 'ended'
    })
    expect([wrappers.mock.calls.length, bind.mock.calls.length, capture.mock.calls.length]).toEqual(
      [0, 0, 0]
    )
    expect(commits).toEqual([undefined, undefined])
    expect(attempt.dispatchCursor).toBeUndefined()
    expect(attempt.firstHandover).toBe(false)
  }
)
