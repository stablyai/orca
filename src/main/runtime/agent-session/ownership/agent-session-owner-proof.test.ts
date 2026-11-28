import { expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { launchedAgentSessionAccount, withMovedAccountHome } from './agent-session-owner-proof'
import { isOptionalAgentSessionLaunchedAccount } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

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

it('keeps the saved account a launch ran on, in the home it ran in, as a record reads it back', () => {
  const started = record([{ handle: { nativeId: 's1' } }])
  const launched = launchedAgentSessionAccount(started, { fence: 3, launchedAccountId: 'work' })
  expect(launched).toEqual({ fence: 3, accountHome: agyHome, accountId: 'work' })
  const fresh = record([])
  expect(
    launchedAgentSessionAccount(fresh, {
      fence: 4,
      launchedAccountId: 'work',
      movedAccountHome: orcaHome
    })
  ).toEqual({ fence: 4, accountHome: orcaHome, accountId: 'work' })
  expect(isOptionalAgentSessionLaunchedAccount(JSON.parse(JSON.stringify(launched)))).toBe(true)
  // Neither a home nor a saved account: nothing is claimed about where this fence ran.
  expect(launchedAgentSessionAccount(started, { fence: 5 })).toBeUndefined()
})
