import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalMailboxSubscriptions } from './terminal-mailbox-subscriptions'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../shared/pty-write-settlement'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import { MAILBOX_POINTER_WRITE_ATTEMPTED } from './db/messages/mailbox-pointer-enter-state'

function fixture() {
  const db = new OrchestrationDb(':memory:')
  const leaf: OrchestrationMailboxLeaf = {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: null
  }
  let incarnation = 'inc-1'
  let authority = true
  let settled = true
  let mailboxOwner = 'term_recipient'
  let waiters: ReadonlySet<{ typeFilter: string[] | undefined }> | undefined
  let agentIdentity: 'codex' | 'cursor' | undefined = 'codex'
  const currentAuthority = () =>
    authority
      ? {
          hostScope: { kind: 'local' as const, hostId: 'local' as const },
          terminalHandle: 'term_recipient',
          paneKey: 'tab-1:leaf-1',
          ptyId: 'pty-1',
          processIncarnation: incarnation
        }
      : null
  const registry = new TerminalMailboxSubscriptions(currentAuthority)
  const target = () => ({
    leaf,
    terminalHandle: 'term_recipient',
    processIncarnation: incarnation,
    ...(agentIdentity ? { agentIdentity } : {})
  })
  const write = vi.fn(
    (_pty: string, _data: string): WriteSettlement | Promise<WriteSettlement> => WRITE_ACCEPTED
  )
  const deps = {
    terminalSubscriptions: registry,
    mailboxOwner: { resolve: () => mailboxOwner },
    deliveryTarget: {
      resolveTerminalHandle: () => 'term_recipient',
      deferForAbsenceProbe: () => false
    },
    getDb: () => db,
    getLeaf: () => leaf,
    getLeafKey: () => 'tab-1:leaf-1',
    getLiveLeafForHandle: () => leaf,
    isAgentSettledForDelivery: () => settled,
    getMessageWaiters: () => waiters,
    getTabTitle: () => null,
    getCliCommand: () => 'orca' as const,
    getTerminalHandleForLeafKey: () => 'term_recipient',
    resolveSubmitTarget: target,
    isLeafPtyProvenAbsent: async () => false,
    redriveMailbox: vi.fn(),
    writePty: write
  }
  const delivery = new OrchestrationMailboxPointerDelivery(deps)
  const subscribe = () => {
    const current = currentAuthority()!
    registry.register(target(), { ...current, createdAt: '2026-09-21T00:00:00.000Z' })
  }
  const mail = () =>
    db.insertMessage({
      runId: 'run_legacy_local',
      from: 'sender',
      to: 'term_recipient',
      subject: 'test',
      body: 'DO_NOT_INJECT_BODY'
    })
  return {
    db,
    leaf,
    registry,
    delivery,
    write,
    mail,
    subscribe,
    target,
    replace: () => {
      incarnation = 'inc-2'
    },
    revoke: () => {
      authority = false
    },
    setSettled: (value: boolean) => {
      settled = value
    },
    setAgentIdentity: (value: 'codex' | 'cursor' | undefined) => {
      agentIdentity = value
    },
    setWaiters: (value: ReadonlySet<{ typeFilter: string[] | undefined }> | undefined) => {
      waiters = value
    },
    setMailboxOwner: (value: string) => {
      mailboxOwner = value
    }
  }
}

describe('bare terminal subscriptions', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps unsubscribed mail durable without writing', () => {
    const f = fixture()
    const message = f.mail()
    f.delivery.deliverForHandle('term_recipient')
    expect(f.write).not.toHaveBeenCalled()
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    f.db.close()
  })

  it('submits only a pointer and preserves unread', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    const message = f.mail()
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('orchestration inbox --terminal term_recipient --full'),
      '\r'
    ])
    expect(f.write.mock.calls[0][1]).not.toContain('DO_NOT_INJECT_BODY')
    expect(f.registry.status('term_recipient').wake).toBe('submitted')
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    f.db.close()
  })

  it.each([
    ['accepted', WRITE_ACCEPTED],
    ['refused', writeRefused('provider_refused_write')],
    ['unverifiable', writeUnverifiable('provider_threw_after_handoff', true)]
  ] as const)(
    'does not attribute an old async pointer %s to a new generation',
    async (_, result) => {
      vi.useFakeTimers()
      const f = fixture()
      let resolveWrite!: (value: WriteSettlement) => void
      const pendingWrite = new Promise<WriteSettlement>((resolve) => {
        resolveWrite = resolve
      })
      f.write.mockReturnValueOnce(pendingWrite)
      f.subscribe()
      f.mail()
      f.delivery.deliverForHandle('term_recipient')
      f.registry.remove('term_recipient')
      f.subscribe()
      resolveWrite(result)
      await vi.advanceTimersByTimeAsync(600)
      expect(f.registry.status('term_recipient')).toMatchObject({
        state: 'active',
        wake: 'deferred',
        reason: 'awaiting_mail_or_idle',
        messageIds: []
      })
      f.db.close()
    }
  )

  it.each([
    ['accepted', WRITE_ACCEPTED],
    ['refused', writeRefused('provider_refused_write')],
    ['unverifiable', writeUnverifiable('provider_threw_after_handoff', true)]
  ] as const)('does not attribute an old async Enter %s to a new generation', async (_, result) => {
    vi.useFakeTimers()
    const f = fixture()
    let resolveEnter!: (value: WriteSettlement) => void
    const pendingEnter = new Promise<WriteSettlement>((resolve) => {
      resolveEnter = resolve
    })
    f.write.mockReturnValueOnce(WRITE_ACCEPTED).mockReturnValueOnce(pendingEnter)
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    f.registry.remove('term_recipient')
    f.subscribe()
    resolveEnter(result)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.registry.status('term_recipient')).toMatchObject({
      state: 'active',
      wake: 'deferred',
      reason: 'awaiting_mail_or_idle',
      messageIds: []
    })
    f.db.close()
  })

  it.each(['unsubscribe', 'replace', 'revoke', 'reregister'] as const)(
    'fences delayed Enter on %s',
    async (action) => {
      vi.useFakeTimers()
      const f = fixture()
      f.subscribe()
      f.mail()
      f.delivery.deliverForHandle('term_recipient')
      if (action === 'unsubscribe' || action === 'reregister') {
        f.registry.remove('term_recipient')
      }
      if (action === 'reregister') {
        f.subscribe()
      }
      if (action === 'replace') {
        f.replace()
      }
      if (action === 'revoke') {
        f.revoke()
      }
      await vi.advanceTimersByTimeAsync(600)
      expect(f.write).toHaveBeenCalledTimes(1)
      f.db.close()
    }
  )

  it('keeps attempted pointer history ambiguous when unsubscribed before Enter', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    const message = f.mail()
    f.delivery.deliverForHandle('term_recipient')
    f.registry.remove('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED,
      pointer_pty_id: 'pty-1',
      pointer_process_incarnation: 'inc-1'
    })
    f.db.close()
  })

  it('leaves a staged pointer for manual submit when the pane starts working', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    f.leaf.lastAgentStatus = 'working'
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    f.leaf.lastAgentStatus = 'idle'
    f.delivery.observeAgentIdle('pty-1')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').state).toBe('blocked_working')
    f.db.close()
  })

  it('does not write through permission/settled refusal', () => {
    const f = fixture()
    f.subscribe()
    f.mail()
    f.setSettled(false)
    f.delivery.deliverForHandle('term_recipient')
    expect(f.write).not.toHaveBeenCalled()
    f.db.close()
  })

  it('does not auto-Enter after permission changes behind a visible pointer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    f.setSettled(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').state).toBe('blocked_permission')
    f.setSettled(true)
    f.delivery.observeAgentIdle('pty-1')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.write).toHaveBeenCalledTimes(1)
    f.db.close()
  })

  it('disables the direct lane when a Run takes mailbox ownership', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    f.setMailboxOwner('run:owner')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient')).toMatchObject({
      state: 'blocked_permission',
      reason: 'mailbox_ownership_changed'
    })
    f.db.close()
  })

  it('does not automatically retry ambiguous pointer writes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.write.mockReturnValue(writeUnverifiable('provider_threw_after_handoff', true))
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    f.delivery.deliverForHandle('term_recipient')
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').wake).toBe('unverifiable')
    f.db.close()
  })

  it('preserves Cursor no-auto-Enter', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.setAgentIdentity('cursor')
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').reason).toBe('manual_submit_required')
    f.db.close()
  })

  it('requires a positive agent identity before auto-Enter', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.setAgentIdentity(undefined)
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').reason).toBe('manual_submit_required')
    f.db.close()
  })

  it('does not auto-Enter when the positive agent identity changes after the pointer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    f.setAgentIdentity('cursor')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').reason).toBe('manual_submit_required')
    f.db.close()
  })

  it('lets an unfiltered inbox waiter preempt pointer delivery', () => {
    const f = fixture()
    f.subscribe()
    const message = f.mail()
    f.setWaiters(new Set([{ typeFilter: undefined }]))
    f.delivery.deliverForHandle('term_recipient')
    expect(f.write).not.toHaveBeenCalled()
    expect(f.db.getMessageById(message.id)?.read).toBe(0)
    f.db.close()
  })

  it('coalesces a burst without consuming either message', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    const first = f.mail()
    const second = f.mail()
    f.delivery.deliverForHandle('term_recipient')
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.db.getMessageById(first.id)?.read).toBe(0)
    expect(f.db.getMessageById(second.id)?.read).toBe(0)
    f.db.close()
  })

  it('keeps an ambiguous Enter fenced across idle edges', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.write
      .mockReturnValueOnce(WRITE_ACCEPTED)
      .mockReturnValue(writeUnverifiable('provider_threw_after_handoff', true))
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    f.delivery.observeAgentWorking('pty-1')
    f.delivery.observeAgentIdle('pty-1')
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(2)
    expect(f.registry.status('term_recipient').wake).toBe('unverifiable')
    f.db.close()
  })

  it.each(['invalid authority', 'Run ownership'] as const)(
    'cleans stale delivery reservations on working after %s',
    (condition) => {
      const f = fixture()
      f.subscribe()
      const message = f.mail()
      expect(
        f.db.stageMailboxPointerEnter([message.id], {
          ptyId: 'pty-1',
          processIncarnation: 'inc-1'
        })
      ).toBe(true)
      if (condition === 'invalid authority') {
        f.revoke()
      } else {
        f.setMailboxOwner('run:owner')
      }
      f.delivery.observeAgentWorking('pty-1')
      expect(f.db.getMessageById(message.id)).toMatchObject({
        pointer_enter_pending: 0,
        pointer_pty_id: null,
        pointer_process_incarnation: null
      })
      expect(f.registry.status('term_recipient').state).toBe(
        condition === 'invalid authority' ? 'host_unverifiable' : 'active'
      )
      f.db.close()
    }
  )

  it('requires re-registration after process replacement and allows later mail', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.subscribe()
    f.mail()
    f.write.mockReturnValueOnce(writeUnverifiable('provider_threw_after_handoff', true))
    f.delivery.deliverForHandle('term_recipient')
    f.replace()
    f.delivery.deliverForHandle('term_recipient')
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.registry.status('term_recipient').state).toBe('stale_replaced')
    f.subscribe()
    f.mail()
    f.delivery.deliverForHandle('term_recipient')
    await vi.advanceTimersByTimeAsync(600)
    expect(f.write).toHaveBeenCalledTimes(3)
    f.db.close()
  })

  it('does not restore registrations after runtime restart or PTY exit', () => {
    const f = fixture()
    f.subscribe()
    expect(new TerminalMailboxSubscriptions().status('term_recipient').subscribed).toBe(false)
    f.delivery.retirePty('pty-1')
    expect(f.registry.status('term_recipient')).toMatchObject({
      subscribed: false,
      state: 'proven_exited'
    })
    f.db.close()
  })

  it('makes same-identity registration idempotent and rejects changed authority', () => {
    const f = fixture()
    f.subscribe()
    const generation = f.registry.generation('term_recipient')
    f.subscribe()
    expect(f.registry.generation('term_recipient')).toBe(generation)
    f.revoke()
    expect(f.registry.status('term_recipient')).toMatchObject({
      subscribed: true,
      state: 'host_unverifiable'
    })
    f.db.close()
  })
})
