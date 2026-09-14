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
  browserHostGeneration: 1,
  pageCommandProtocolVersion: 1
}

describe('BrowserHostCommandLedger capacity and snapshots', () => {
  it('expires cached results at exact per-page and global ceilings', async () => {
    const ledger = new BrowserHostCommandLedger({
      authority,
      maxCachedResults: 2,
      maxCachedResultsPerPage: 1
    })
    ledger.attach(vi.fn())
    const first = issueCreate(ledger, 'page-a', 1)
    ledger.settle(resultParams(first.event, { status: 'completed' }))
    await first.result
    const second = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: { type: 'navigate', url: 'https://remote.internal/a' }
    })
    ledger.settle(resultParams(second.event, { status: 'completed' }))
    await second.result

    expect(() => ledger.settle(resultParams(first.event, { status: 'completed' }))).toThrow(
      'browser_host_command_result_expired'
    )
    expect(ledger.settle(resultParams(second.event, { status: 'completed' }))).toBe(false)

    const third = issueCreate(ledger, 'page-b', 2)
    ledger.settle(resultParams(third.event, { status: 'completed' }))
    await third.result
    const fourth = issueCreate(ledger, 'page-c', 3)
    ledger.settle(resultParams(fourth.event, { status: 'completed' }))
    await fourth.result

    expect(() => ledger.settle(resultParams(second.event, { status: 'completed' }))).toThrow(
      'browser_host_command_result_expired'
    )
    expect(ledger.settle(resultParams(third.event, { status: 'completed' }))).toBe(false)
    expect(ledger.settle(resultParams(fourth.event, { status: 'completed' }))).toBe(false)
  })

  it('freezes accepted authority, command, and result snapshots', async () => {
    const mutableAuthority = { ...authority }
    const ledger = new BrowserHostCommandLedger({ authority: mutableAuthority })
    ledger.attach(vi.fn())
    const command = {
      type: 'createPage' as const,
      browserProfileId: 'default',
      executionHostKey: 'host-key-original'
    }
    const issued = ledger.issue({ browserPageId: 'page-a', pageHostGeneration: 1, command })
    mutableAuthority.authorityEpoch = 'epoch-b'
    command.executionHostKey = 'host-key-mutated'
    const result: BrowserClientHostCommandResult = {
      status: 'failed',
      errorCode: 'original'
    }
    ledger.settle(resultParams(issued.event, result))
    result.errorCode = 'mutated'

    expect(issued.event.authorityEpoch).toBe('epoch-a')
    expect(issued.event.command).toMatchObject({ executionHostKey: 'host-key-original' })
    await expect(issued.result).resolves.toEqual({ status: 'failed', errorCode: 'original' })
  })

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
