import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostLeaseAuthority } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BrowserHostCommandLedger } from './browser-host-command-ledger'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 1,
  pageCommandProtocolVersion: 1
}

describe('BrowserHostCommandLedger capacity and snapshots', () => {
  it('closes all outstanding outcomes when command delivery throws', async () => {
    const delivery = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('transport closed')
      })
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(delivery)
    const first = issueCreate(ledger, 'page-a', 1)

    expect(() => issueCreate(ledger, 'page-b', 2)).toThrow('browser_host_command_delivery_failed')
    await expect(first.result).rejects.toThrow('browser_host_command_outcome_unknown')
    expect(() => issueCreate(ledger, 'page-c', 3)).toThrow('browser_host_command_ledger_closed')
  })

  it('rejects oversized wire payloads before consuming page or sequence admission', async () => {
    const delivery = vi.fn()
    const ledger = new BrowserHostCommandLedger({ authority, maxPages: 1 })
    ledger.attach(delivery)

    expect(() =>
      ledger.issue({
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        command: {
          type: 'createPage',
          browserProfileId: 'x'.repeat(257),
          executionHostKey: 'host-key-a'
        }
      })
    ).toThrow()
    const issued = issueCreate(ledger, 'page-b', 2)

    expect(issued.event.commandSequence).toBe(1)
    expect(delivery).toHaveBeenCalledTimes(1)
    ledger.settle(resultParams(issued.event, { status: 'completed' }))
    await issued.result
  })

  it('releases completed close capacity while retaining exact result replay', async () => {
    const ledger = new BrowserHostCommandLedger({ authority, maxPages: 1 })
    ledger.attach(vi.fn())
    const created = issueCreate(ledger, 'page-a', 1)
    ledger.settle(resultParams(created.event, { status: 'completed' }))
    await created.result
    const closed = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'closePage',
        targetAuthority: {
          authorityRuntimeId: 'runtime-a',
          authorityEpoch: 'epoch-a',
          browserHostClientId: 'host-a',
          browserHostGeneration: 1,
          pageHostGeneration: 1
        }
      }
    })
    ledger.settle(resultParams(closed.event, { status: 'completed' }))
    await closed.result

    const replacement = issueCreate(ledger, 'page-b', 2)

    expect(ledger.settle(resultParams(closed.event, { status: 'completed' }))).toBe(false)
    ledger.settle(resultParams(replacement.event, { status: 'completed' }))
    await replacement.result
  })
})

function issueCreate(ledger: BrowserHostCommandLedger, browserPageId: string, generation: number) {
  return ledger.issue({
    browserPageId,
    pageHostGeneration: generation,
    command: {
      type: 'createPage',
      browserProfileId: 'default',
      executionHostKey: 'host-key-a'
    }
  })
}

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
