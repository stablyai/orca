import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientError, RuntimeRpcFailureError } from '../../runtime-client'
import { orchestrationTestContext } from '../orchestration-handler-test-context'
import { SESSION_LINK_OWNER_CHOICES_CAPABILITY } from '../../../shared/session-link'
import { ORCHESTRATION_LINK_HANDLERS } from './session-link-handlers'

describe('link operation recovery errors', () => {
  it('rejects a missing control turn before RPC without retry guidance', async () => {
    const call = vi.fn()
    const context = orchestrationTestContext(
      call,
      new Map([
        ['id', 'pair'],
        ['action', 'end']
      ]),
      true
    )
    await expect(
      ORCHESTRATION_LINK_HANDLERS['orchestration link-control'](context)
    ).rejects.toThrow(/^Missing required --turn-operation$/)
    expect(call).not.toHaveBeenCalled()
  })

  for (const command of ['link-send', 'link-control']) {
    it.each(['client', 'rpc'])(`preserves %s error codes and data for ${command}`, async (kind) => {
      const data = { effectsApplied: false, recovery: { query: 'inspect' } }
      const error =
        kind === 'rpc'
          ? new RuntimeRpcFailureError({
              id: 'refusal',
              ok: false,
              error: { code: 'session_link_refused', message: 'Refused', data }
            })
          : new RuntimeClientError('runtime_timeout', 'Reply lost', data)
      const call = vi.fn().mockRejectedValue(error)
      const context = orchestrationTestContext(
        call,
        new Map([
          ['id', 'pair'],
          ['body', 'Report'],
          ['action', 'end'],
          ['operation', 'retry-op'],
          ['turn-operation', 'delivery-op']
        ]),
        true
      )
      await expect(
        ORCHESTRATION_LINK_HANDLERS[`orchestration ${command}`](context)
      ).rejects.toMatchObject({
        code: error.code,
        data,
        message: expect.stringContaining('--operation retry-op')
      })
    })
  }
})

const choices = [
  { label: 'Approve $0.10' },
  { label: 'Offline only', description: 'No provider calls' }
]
describe('owner question CLI compatibility', () => {
  it.each([true, false])(
    'preserves the decision on a host with choices support=%s',
    async (supported) => {
      const call = vi.fn().mockImplementation(async (method: string) => {
        if (method === 'status.get') {
          return {
            result: { capabilities: supported ? [SESSION_LINK_OWNER_CHOICES_CAPABILITY] : [] }
          }
        }
        throw new Error('captured send')
      })
      const context = orchestrationTestContext(
        call,
        new Map([
          ['id', 'pair'],
          ['body', 'Continue?'],
          ['operation', 'ask-1'],
          ['kind', 'owner-request'],
          ['choices-json', JSON.stringify(choices)],
          ['allow-other', 'false']
        ]),
        true
      )
      await expect(ORCHESTRATION_LINK_HANDLERS['orchestration link-send'](context)).rejects.toThrow(
        'captured send'
      )
      const sent = call.mock.calls.find(([method]) => method === 'orchestration.linkSend')?.[1]
      if (supported) {
        expect(sent).toMatchObject({ choices, allowOther: false, body: 'Continue?' })
      } else {
        expect(sent).not.toHaveProperty('choices')
        expect(sent).not.toHaveProperty('allowOther')
        expect(sent.body).toContain('1. Approve $0.10')
        expect(sent.body).toContain('2. Offline only — No provider calls')
      }
    }
  )
  it('refuses choices on a partner message before any RPC', async () => {
    const call = vi.fn()
    const context = orchestrationTestContext(
      call,
      new Map([
        ['id', 'pair'],
        ['body', 'Report'],
        ['choices-json', JSON.stringify(choices)]
      ]),
      true
    )
    await expect(ORCHESTRATION_LINK_HANDLERS['orchestration link-send'](context)).rejects.toThrow(
      'owner requests'
    )
    expect(call).not.toHaveBeenCalled()
  })
})
