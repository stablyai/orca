import { expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { withMovedAccountHome } from './agent-session-owner-proof'

const agyHome = { variable: 'GEMINI_HOME', path: '/home/u/.gemini' }
const orcaHome = { variable: 'GEMINI_HOME', path: '/data/antigravity-agy-chat' }

function record(providerHandleChain: unknown[]): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two fields the rule reads matter here.
  return { accountHome: agyHome, providerHandleChain } as unknown as AgentSessionRecord
}

it('moves only a chat with no conversation yet; one with history stays where it lives', () => {
  const fresh = record([])
  expect(withMovedAccountHome(fresh, fresh, orcaHome).accountHome).toEqual(orcaHome)
  const started = record([{ handle: { nativeId: 's1' } }])
  expect(withMovedAccountHome(started, started, orcaHome).accountHome).toEqual(agyHome)
  expect(withMovedAccountHome(fresh, fresh, undefined).accountHome).toEqual(agyHome)
})
