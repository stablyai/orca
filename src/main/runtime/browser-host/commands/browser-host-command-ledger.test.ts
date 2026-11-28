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
  it('settles and replays safe legacy navigation results after direct and staged receipt', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const created = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: { type: 'createPage', browserProfileId: 'default', executionHostKey: 'host-key-a' }
    })
    ledger.settle(resultParams(created.event, { status: 'completed' }))
    for (const staged of [false, true]) {
      const issued = ledger.issue({
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        command: { type: 'automation', method: 'browser.reload', params: {}, stagedResults: true }
      })
      const reply = {
        status: 'completed' as const,
        value: {
          url: 'https://kagi.com/search?token=cache-secret&q=one',
          title: 'https://kagi.com/search?token=cache-secret&q=one'
        }
      }
      const params = resultParams(issued.event, reply)
      if (staged) {
        const json = Buffer.from(JSON.stringify(reply.value))
        ledger.stageResultChunk({ ...params, offset: 0, contentBase64: json.toString('base64') })
        ledger.settle({
          ...params,
          result: { status: 'completed', stagedValueBytes: json.byteLength }
        })
      } else {
        ledger.settle(params)
      }
      await expect(issued.result).resolves.toEqual({
        status: 'completed',
        value: {
          url: 'https://kagi.com/search?q=one',
          title: 'https://kagi.com/search?q=one'
        }
      })
      expect(ledger.settle(params)).toBe(false)
    }
  })

  it('settles a safe old-client redirect failure before retaining its result', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const created = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: { type: 'createPage', browserProfileId: 'default', executionHostKey: 'host-key-a' }
    })
    ledger.settle(resultParams(created.event, { status: 'completed' }))
    const issued = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: {
        type: 'automation',
        method: 'browser.goto',
        params: { url: 'https://example.com/' }
      }
    })
    const params = resultParams(issued.event, {
      status: 'failed',
      errorCode: 'browser_error',
      errorMessage: "ERR_FAILED loading 'https://kagi.com/search?token=cache-secret&q=one'"
    })
    ledger.settle(params)
    await expect(issued.result).resolves.toEqual({
      status: 'failed',
      errorCode: 'browser_error',
      errorMessage: 'Private navigation failed.'
    })
    expect(ledger.settle(params)).toBe(false)
  })

  it('sanitizes direct and staged legacy upload frame receipts before retaining them', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const created = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: { type: 'createPage', browserProfileId: 'default', executionHostKey: 'host-key-a' }
    })
    ledger.settle(resultParams(created.event, { status: 'completed' }))
    for (const [raw, safe, staged] of [
      ['https://kagi.com/search?token=frame-secret&q=one', 'https://kagi.com/search?q=one', false],
      ['https://kagi.com/search?token=frame-secret&q=one', 'https://kagi.com/search?q=one', true],
      [
        'https://example.com/frame?token=ordinary',
        'https://example.com/frame?token=ordinary',
        false
      ],
      ['https://example.com/frame?token=ordinary', 'https://example.com/frame?token=ordinary', true]
    ] as const) {
      const issued = ledger.issue({
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        command: { type: 'automation', method: 'browser.upload', params: {}, stagedResults: true }
      })
      const reply = {
        status: 'completed' as const,
        value: {
          uploaded: 1,
          frameUrl: raw
        }
      }
      const params = resultParams(issued.event, reply)
      if (staged) {
        const json = Buffer.from(JSON.stringify(reply.value))
        ledger.stageResultChunk({ ...params, offset: 0, contentBase64: json.toString('base64') })
        ledger.settle({
          ...params,
          result: { status: 'completed', stagedValueBytes: json.byteLength }
        })
      } else {
        ledger.settle(params)
      }
      await expect(issued.result).resolves.toEqual({
        status: 'completed',
        value: {
          uploaded: 1,
          frameUrl: safe
        }
      })
      expect(ledger.settle(params)).toBe(false)
    }
  })
  it('sanitizes direct and staged legacy URL getter strings before retention', async () => {
    const ledger = new BrowserHostCommandLedger({ authority })
    ledger.attach(vi.fn())
    const created = ledger.issue({
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      command: { type: 'createPage', browserProfileId: 'default', executionHostKey: 'host-key-a' }
    })
    ledger.settle(resultParams(created.event, { status: 'completed' }))
    for (const staged of [false, true]) {
      const issued = ledger.issue({
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        command: {
          type: 'automation',
          method: 'browser.get',
          params: { what: 'url' },
          stagedResults: true
        }
      })
      const value = 'https://kagi.com/search?token=get-secret&q=one'
      const params = resultParams(issued.event, { status: 'completed', value })
      if (staged) {
        const json = Buffer.from(JSON.stringify(value))
        ledger.stageResultChunk({ ...params, offset: 0, contentBase64: json.toString('base64') })
        ledger.settle({
          ...params,
          result: { status: 'completed', stagedValueBytes: json.byteLength }
        })
      } else {
        ledger.settle(params)
      }
      await expect(issued.result).resolves.toEqual({
        status: 'completed',
        value: 'https://kagi.com/search?q=one'
      })
    }
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
