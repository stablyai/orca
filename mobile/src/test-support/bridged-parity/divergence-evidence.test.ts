import { describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import {
  createBridgePortPair,
  disposeBridgePortPair,
  type BridgePortPair
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import type { RpcClient } from '../../transport/rpc-client'
import { ScriptedRpcTransport } from '../rpc-recording/scripted-rpc-transport'
import { agentHistoryHostStatusRead } from '../../agent-history/mobile-agent-history-operations'
import { withReplyMeta } from './divergence-evidence'

describe('reading the refused frames back', () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaa'
  it('changes no verdict on a reply, now that the field is not what the page reads for', () => {
    const reply = JSON.stringify({
      v: 1,
      type: 'reply',
      id,
      payload: { id: 'f', ok: true, result: 1 }
    })
    expect(readBridgeHostMessage(reply).ok).toBe(true)
    expect(readBridgeHostMessage(withReplyMeta(reply)).ok).toBe(true)
  })
  it('leaves a payload the page refuses for its own shape refused', () => {
    const absent = JSON.stringify({ v: 1, type: 'reply', id, payload: { id: 'f', ok: true } })
    expect(readBridgeHostMessage(withReplyMeta(absent)).ok).toBe(false)
  })
})

describe('the fields that diverged', () => {
  it('attributes a real malformed exchange without excusing valid wire changes beside it', async () => {
    const native = new ScriptedRpcTransport()
    const pairs: BridgePortPair<RpcClient>[] = []
    const bridges = [undefined, withReplyMeta].map(
      (rewriteToPage) =>
        new ScriptedRpcTransport(
          () => 0,
          undefined,
          (rpc, observation) => {
            const pair = createBridgePortPair({
              rpc,
              observation: observation.openBridge(),
              rewriteToPage
            })
            pairs.push(pair)
            observation.onDispose(() => disposeBridgePortPair(pair))
            for (let turn = 0; turn < 4; turn += 1) {
              pair.drainNow()
            }
            return pair.client
          }
        )
    )
    const cleanup = async () => {
      const errors: unknown[] = []
      for (const transport of [native, ...bridges]) {
        try {
          await transport.dispose()
        } catch (error) {
          errors.push(error)
        }
        try {
          transport.causality.assertTransparentCalls()
        } catch (error) {
          errors.push(error)
        }
        transport.causality.close()
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length) {
        throw new AggregateError(errors, 'Malformed exchange cleanup failed')
      }
    }
    try {
      const normal = native.client.sendRequest('status.get', {})
      const worktrees = native.client.sendRequest('worktree.ps', { limit: 10000 })
      const pending = bridges.map((bridge) => [
        bridge.client.sendRequest('status.get', {}).catch((error: unknown) => error),
        bridge.client.sendRequest('worktree.ps', { limit: 10000 }).catch((error: unknown) => error)
      ])
      await Promise.all(pairs.map((pair) => pair.flush()))
      const worktreeParams = { limit: 10000, supportsWorktreeVisibilitySourceDefaults: true }
      native.complete('status.get#1', {}, { ok: true })
      native.complete('worktree.ps#1', worktreeParams, { ok: true })
      for (const bridge of bridges) {
        bridge.complete('status.get#1.native-1', {}, { ok: true })
        bridge.complete('worktree.ps#1.native-1', worktreeParams, { ok: true })
      }
      await worktrees
      const reply = await normal
      expect(() => agentHistoryHostStatusRead.interpret(reply)).toThrow(
        'The host sent a reply this app could not read (status.get)'
      )
      for (const [index, bridge] of bridges.entries()) {
        await pairs[index]!.flush()
        const [statusError, worktreeError] = await Promise.all(pending[index]!)
        expect(statusError).toBeInstanceOf(Error)
        expect(worktreeError).toBeInstanceOf(Error)
        expect(statusError).toMatchObject({
          message: 'the reply could not be read (unrecognised-message)'
        })
        expect(worktreeError).toMatchObject({
          message: 'the reply could not be read (unrecognised-message)'
        })
        const posted = pairs[index]!.readToShell().filter((frame) => frame.type === 'request')
        expect(posted.map((frame) => frame.method)).toEqual(['status.get', 'worktree.ps'])
        expect(posted.map((frame) => frame.params)).toEqual([{}, { limit: 10000 }])
        const emitted = bridge.payloads.map((row) => JSON.parse(row.json))
        expect(emitted).toEqual([
          { id: 'frame-1', deviceToken: 'recording-device', method: 'status.get', params: {} },
          {
            id: 'frame-2',
            deviceToken: 'recording-device',
            method: 'worktree.ps',
            params: worktreeParams
          }
        ])
        const rawReplies = pairs[index]!.toPage.filter((json) => JSON.parse(json).type === 'reply')
        expect(rawReplies).toHaveLength(2)
        expect(rawReplies.every((json) => !readBridgeHostMessage(json).ok)).toBe(true)
        expect(bridge.requests.map((row) => row.bridge!.posts[0]!.children[0]!.frame!.id)).toEqual([
          'frame-1',
          'frame-2'
        ])
        expect(bridge.pendingRequests()).toBe(0)
      }
    } finally {
      await cleanup()
    }
  })
})
