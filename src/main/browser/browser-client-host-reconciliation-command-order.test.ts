import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { describe, expect, it, vi } from 'vitest'
import { BrowserHostCommandLedger } from '../runtime/browser-host-command-ledger'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'

const authority: BrowserClientHostLeaseAuthority & {
  pageCommandProtocolVersion: 1
  pageReconciliationProtocolVersion: 1
} = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-new',
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageCommandProtocolVersion: 1,
  pageReconciliationProtocolVersion: 1
}

const previousAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-old',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageHostGeneration: 7
}

function event(
  command: BrowserClientHostCommandEvent['command'],
  overrides: Partial<BrowserClientHostCommandEvent> = {}
): BrowserClientHostCommandEvent {
  return {
    type: 'command',
    ...authority,
    browserPageId: 'page-a',
    pageHostGeneration: command.type === 'closePage' ? 7 : 8,
    commandSequence: 1,
    commandId: `${command.type}-a`,
    command,
    ...overrides
  }
}

describe('browser reconciliation command ordering', () => {
  it.each([
    {
      type: 'reclaimPage' as const,
      previousAuthority,
      browserProfileId: 'profile-a',
      executionHostKey: 'host-key-a'
    },
    {
      type: 'restorePage' as const,
      browserProfileId: 'profile-a',
      executionHostKey: 'host-key-a'
    },
    { type: 'closePage' as const, targetAuthority: previousAuthority }
  ])('admits $type as an authenticated first client-dispatch command', async (command) => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })

    await expect(dispatcher.dispatch(event(command))).resolves.toEqual({ status: 'completed' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('deduplicates exact reclaim bootstrap and rejects changed prior authority', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    const reclaim = event({
      type: 'reclaimPage',
      previousAuthority,
      browserProfileId: 'profile-a',
      executionHostKey: 'host-key-a'
    })

    const first = dispatcher.dispatch(reclaim)
    const duplicate = dispatcher.dispatch(reclaim)
    await expect(first).resolves.toEqual({ status: 'completed' })
    await expect(duplicate).resolves.toEqual({ status: 'completed' })
    expect(handler).toHaveBeenCalledOnce()
    expect(() =>
      dispatcher.dispatch({
        ...reclaim,
        command: {
          ...reclaim.command,
          previousAuthority: { ...previousAuthority, authorityEpoch: 'different' }
        }
      } as BrowserClientHostCommandEvent)
    ).toThrow('browser_host_command_sequence_conflict')
  })

  it('snapshots nested reconciliation authority on both sides of dispatch', async () => {
    const handler = vi.fn().mockResolvedValue({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    const clientAuthority = { ...previousAuthority }
    const clientEvent = event({
      type: 'reclaimPage',
      previousAuthority: clientAuthority,
      browserProfileId: 'profile-a',
      executionHostKey: 'host-key-a'
    })

    const dispatched = dispatcher.dispatch(clientEvent)
    clientAuthority.authorityEpoch = 'mutated-client'
    await dispatched
    const accepted = handler.mock.calls[0]?.[0] as BrowserClientHostCommandEvent
    expect(accepted.command).toMatchObject({
      previousAuthority: expect.objectContaining({ authorityEpoch: 'epoch-old' })
    })
    expect(
      Object.isFrozen(accepted.command.type === 'reclaimPage' && accepted.command.previousAuthority)
    ).toBe(true)

    const delivery = vi.fn()
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(delivery)
    const serverAuthority = { ...previousAuthority }
    ledger.issue({
      browserPageId: 'page-b',
      pageHostGeneration: 8,
      command: {
        type: 'reclaimPage',
        previousAuthority: serverAuthority,
        browserProfileId: 'profile-a',
        executionHostKey: 'host-key-a'
      }
    })
    serverAuthority.authorityEpoch = 'mutated-server'
    const emitted = delivery.mock.calls[0]?.[0] as BrowserClientHostCommandEvent
    expect(emitted.command).toMatchObject({
      previousAuthority: expect.objectContaining({ authorityEpoch: 'epoch-old' })
    })
    expect(
      Object.isFrozen(emitted.command.type === 'reclaimPage' && emitted.command.previousAuthority)
    ).toBe(true)
  })

  it.each(['reclaimPage', 'restorePage'] as const)(
    'cancels navigation when %s bootstrap fails',
    async (type) => {
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ status: 'failed', errorCode: 'bootstrap_failed' })
      const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
      const bootstrap =
        type === 'reclaimPage'
          ? {
              type,
              previousAuthority,
              browserProfileId: 'profile-a',
              executionHostKey: 'host-key-a'
            }
          : {
              type,
              browserProfileId: 'profile-a',
              executionHostKey: 'host-key-a'
            }
      const first = dispatcher.dispatch(event(bootstrap))
      const navigate = dispatcher.dispatch(
        event(
          { type: 'navigate', url: 'https://remote.internal/' },
          { commandSequence: 2, commandId: `${type}-navigate` }
        )
      )

      await expect(first).resolves.toEqual({
        status: 'failed',
        errorCode: 'bootstrap_failed'
      })
      await expect(navigate).resolves.toEqual({
        status: 'failed',
        errorCode: 'browser_host_command_dependency_failed'
      })
      expect(handler).toHaveBeenCalledOnce()
    }
  )

  it('makes an exact close terminal while allowing navigate after reclaim', async () => {
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler: vi.fn().mockResolvedValue({ status: 'completed' })
    })
    await dispatcher.dispatch(
      event({
        type: 'reclaimPage',
        previousAuthority,
        browserProfileId: 'profile-a',
        executionHostKey: 'host-key-a'
      })
    )
    await expect(
      dispatcher.dispatch(
        event(
          { type: 'navigate', url: 'https://remote.internal/' },
          { commandSequence: 2, commandId: 'navigate-a' }
        )
      )
    ).resolves.toEqual({ status: 'completed' })

    const closing = new BrowserClientHostCommandDispatcher({
      authority,
      handler: vi.fn().mockResolvedValue({ status: 'completed' })
    })
    await closing.dispatch(event({ type: 'closePage', targetAuthority: previousAuthority }))
    expect(() =>
      closing.dispatch(
        event(
          { type: 'navigate', url: 'https://remote.internal/' },
          { commandSequence: 2, commandId: 'navigate-after-close', pageHostGeneration: 7 }
        )
      )
    ).toThrow('browser_host_page_generation_stale')
  })

  it('allows the same generation to continue after a failed close', async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', errorCode: 'authority_stale' })
      .mockResolvedValueOnce({ status: 'completed' })
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })

    await expect(
      dispatcher.dispatch(event({ type: 'closePage', targetAuthority: previousAuthority }))
    ).resolves.toEqual({ status: 'failed', errorCode: 'authority_stale' })
    await expect(
      dispatcher.dispatch(
        event(
          { type: 'navigate', url: 'https://remote.internal/' },
          { commandSequence: 2, commandId: 'navigate-after-failed-close', pageHostGeneration: 7 }
        )
      )
    ).resolves.toEqual({ status: 'completed' })
  })

  it('issues reconciliation bootstrap commands from the server ledger without create', () => {
    const delivery = vi.fn()
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(delivery)

    const reclaim = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 8,
      command: {
        type: 'reclaimPage',
        previousAuthority,
        browserProfileId: 'profile-a',
        executionHostKey: 'host-key-a'
      }
    })
    const navigate = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 8,
      command: { type: 'navigate', url: 'https://remote.internal/' }
    })
    const close = ledger.issue({
      browserPageId: 'page-b',
      pageHostGeneration: 9,
      resultAdmission: 'reconciliation',
      command: {
        type: 'closePage',
        targetAuthority: { ...previousAuthority, pageHostGeneration: 9 }
      }
    })

    expect(reclaim.event.commandSequence).toBe(1)
    expect(navigate.event.commandSequence).toBe(2)
    expect(close.event.commandSequence).toBe(1)
    expect(delivery).toHaveBeenCalledTimes(3)
    expect(() =>
      ledger.issue({
        browserPageId: 'page-b',
        pageHostGeneration: 9,
        command: { type: 'navigate', url: 'https://after-close.invalid/' }
      })
    ).toThrow('browser_host_command_page_terminal')
  })
})
