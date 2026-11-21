import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostLeaseAuthority } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BrowserHostCommandLedger } from './browser-host-command-ledger'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1
}

describe('BrowserHostCommandLedger', () => {
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

  it('settles a chunked automation result as the value its chunks carried', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const created = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: { type: 'createPage', browserProfileId: 'default', executionHostKey: 'host-key-a' }
    })
    ledger.settle(resultParams(created.event, { status: 'completed' }))
    const screenshot = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'automation',
        method: 'browser.screenshot',
        params: {},
        stagedResults: true
      }
    })
    const { result: _result, ...identity } = resultParams(screenshot.event, { status: 'completed' })
    const json = Buffer.from('{"data":"iVBORw0KGgo=","format":"png"}')
    ledger.stageResultChunk({
      ...identity,
      offset: 0,
      contentBase64: json.subarray(0, 20).toString('base64')
    })
    ledger.stageResultChunk({
      ...identity,
      offset: 20,
      contentBase64: json.subarray(20).toString('base64')
    })
    ledger.settle({ ...identity, result: { status: 'completed', stagedValueBytes: 38 } })

    await expect(screenshot.result).resolves.toEqual({
      status: 'completed',
      value: { data: 'iVBORw0KGgo=', format: 'png' }
    })
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
