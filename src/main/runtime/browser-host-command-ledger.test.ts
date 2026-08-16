import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BrowserHostCommandLedger } from './browser-host-command-ledger'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1
}

describe('BrowserHostCommandLedger', () => {
  it('publishes bounded per-page sequences and settles results in order', async () => {
    const emit = vi.fn()
    const ledger = new BrowserHostCommandLedger({
      authority,
      createCommandId: (sequence) => `command-${sequence}`
    })
    ledger.attach(emit)
    const create = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 4,
      command: {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    })
    const navigate = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 4,
      command: { type: 'navigate', url: 'https://remote.internal' }
    })

    expect(emit.mock.calls.map(([event]) => event.commandSequence)).toEqual([1, 2])
    expect(() => ledger.settle(resultParams(navigate.event, { status: 'completed' }))).toThrow(
      'browser_host_command_result_sequence_gap'
    )
    expect(ledger.settle(resultParams(create.event, { status: 'completed' }))).toBe(true)
    expect(ledger.settle(resultParams(navigate.event, { status: 'completed' }))).toBe(true)
    await expect(create.result).resolves.toEqual({ status: 'completed' })
    await expect(navigate.result).resolves.toEqual({ status: 'completed' })
  })

  it('accepts exact result replay but rejects conflicting or stale results', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const issued = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    })
    const completed = resultParams(issued.event, { status: 'completed' })

    expect(ledger.settle(completed)).toBe(true)
    expect(ledger.settle(completed)).toBe(false)
    expect(() =>
      ledger.settle(resultParams(issued.event, { status: 'failed', errorCode: 'different' }))
    ).toThrow('browser_host_command_result_conflict')
    expect(() => ledger.settle({ ...completed, authorityEpoch: 'epoch-b' })).toThrow(
      'browser_host_command_result_authority_stale'
    )
    await issued.result
  })

  it('requires delivery and bounds outstanding commands before side effects', async () => {
    const ledger = new BrowserHostCommandLedger({
      authority,
      maxOutstandingCommands: 1,
      maxOutstandingCommandsPerPage: 1
    })
    const input = {
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'createPage' as const,
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    }

    expect(() => ledger.issue(input)).toThrow('browser_host_command_delivery_required')
    ledger.attach(vi.fn())
    const issued = ledger.issue(input)
    expect(() =>
      ledger.issue({
        browserPageId: 'page-b',
        pageHostGeneration: 2,
        command: { ...input.command }
      })
    ).toThrow('browser_host_command_capacity')
    ledger.settle(resultParams(issued.event, { status: 'completed' }))
    await issued.result
  })

  it('fences outstanding outcomes and rejects late results on close', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const issued = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    })
    void issued.result.catch(() => undefined)

    ledger.close()
    await expect(issued.result).rejects.toThrow('browser_host_command_outcome_unknown')
    expect(() => ledger.settle(resultParams(issued.event, { status: 'completed' }))).toThrow(
      'browser_host_command_ledger_closed'
    )
  })

  it('makes outstanding outcomes unknown at exact page retirement', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const issued = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    })

    expect(ledger.retirePage('page-a', 1)).toBe(true)
    await expect(issued.result).rejects.toThrow('browser_host_command_outcome_unknown')
    expect(() => ledger.settle(resultParams(issued.event, { status: 'completed' }))).toThrow(
      'browser_host_command_result_page_stale'
    )
  })

  it('admits page state transactionally and releases exact retired generations', async () => {
    const ledger = new BrowserHostCommandLedger({ authority, maxPages: 1 })
    ledger.attach(vi.fn())
    expect(() =>
      ledger.issue({
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        command: { type: 'navigate', url: 'https://remote.internal' }
      })
    ).toThrow('browser_host_command_create_required')
    const issued = ledger.issue({
      browserPageId: 'page-b',
      pageHostGeneration: 2,
      command: {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host-key-a'
      }
    })
    expect(() =>
      ledger.issue({
        browserPageId: 'page-c',
        pageHostGeneration: 3,
        command: {
          type: 'createPage',
          browserProfileId: 'default',
          executionHostKey: 'host-key-a'
        }
      })
    ).toThrow('browser_host_command_page_capacity')
    ledger.settle(resultParams(issued.event, { status: 'completed' }))
    await issued.result
    expect(ledger.retirePage('page-b', 2)).toBe(true)
    expect(() => ledger.retirePage('page-b', 1)).not.toThrow()
  })
})

function resultParams(
  event: ReturnType<BrowserHostCommandLedger['issue']>['event'],
  result: BrowserClientHostCommandResult
) {
  return {
    pageCommandProtocolVersion: 1 as const,
    authorityRuntimeId: event.authorityRuntimeId,
    authorityEpoch: event.authorityEpoch,
    browserHostClientId: event.browserHostClientId,
    browserHostGeneration: event.browserHostGeneration,
    browserPageId: event.browserPageId,
    pageHostGeneration: event.pageHostGeneration,
    commandSequence: event.commandSequence,
    commandId: event.commandId,
    result
  }
}
