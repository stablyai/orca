import { expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import { STRUCTURED_AGENT_SESSION_AUTO_REVIEW_METHODS } from './structured-agent-session-auto-review-approval'

const [approve] = STRUCTURED_AGENT_SESSION_AUTO_REVIEW_METHODS

it("refuses an agent's or plugin's approval of its own denied action before reaching any chat", async () => {
  const params = { sessionId: 'session-1', itemId: 'denial-1' }
  const callers: Partial<RpcContext>[] = [
    { caller: { kind: 'local-cli' } },
    { caller: { kind: 'paired-device', deviceId: 'device-1', agent: true } },
    // A paired client's agent marker is its own claim, so an unmarked one is no proof of a person.
    { caller: { kind: 'paired-device', deviceId: 'device-1' }, clientKind: 'mobile' },
    { caller: { kind: 'desktop' }, plugin: { key: 'plugin', name: 'Plugin' } },
    {}
  ]
  for (const ctx of callers) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal reads only caller and plugin.
    expect(await approve!.handler(params, ctx as RpcContext)).toEqual({ status: 'refused' })
  }
})
