import { afterEach, describe, expect, it } from 'vitest'
import type { PluginHookChainOutcome } from '../../shared/plugins/workers/plugin-hook-chain'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'
import { botStructuredSessionWiring } from './bot-structured-session-wiring'

const accounts = [
  { id: 'a1', email: 'work@example.com' },
  { id: 'a2', email: 'home@example.com' }
].map((account) => ({
  ...account,
  managedAuthPath: `/tmp/${account.id}`,
  authMethod: 'subscription-oauth' as const,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}))

function payloadFields(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload))
    : {}
}

function wiring(automations: { id: string; account?: string }[]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the account path never reads these collaborators
  const none = {} as never
  return botStructuredSessionWiring({
    store: () => ({
      getRepos: () => [],
      getSettings: () => ({ claudeManagedAccounts: accounts }),
      getWorktreeMeta: (id) =>
        id === 'ws-auto' ? { automationProvenance: { automationId: 'auto-1' } } : undefined,
      listAutomations: () => automations
    }),
    bots: none,
    chats: none,
    work: none,
    lookAround: none
  })
}

const recordIn = (workspaceId: string): AgentSessionRecord =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only provider and location.workspaceId
  ({ provider: 'claude', location: { workspaceId } }) as unknown as AgentSessionRecord

describe('resolveClaudeRequestedAccount for a chat with no bot', () => {
  afterEach(() => setPluginHookRunner(null))

  it('uses the account of the automation that created the workspace', async () => {
    const { resolveClaudeRequestedAccount } = wiring([
      { id: 'auto-1', account: 'home@example.com' }
    ])
    expect(await resolveClaudeRequestedAccount(recordIn('ws-auto'))).toEqual({
      kind: 'managed',
      accountId: 'a2'
    })
  })

  it('follows the host selection when the automation has no account and no plugin answers', async () => {
    const { resolveClaudeRequestedAccount } = wiring([{ id: 'auto-1' }])
    expect(await resolveClaudeRequestedAccount(recordIn('ws-auto'))).toBeNull()
  })

  it('lets a plugin pick the account and hands it the automation id', async () => {
    const seen: Record<string, unknown>[] = []
    setPluginHookRunner({
      wants: (event) => event === 'agent.account.resolve',
      run: async (_event, payload): Promise<PluginHookChainOutcome> => {
        const fields = payloadFields(payload)
        seen.push(fields)
        return { kind: 'continue', payload: { ...fields, account: 'work@example.com' } }
      }
    })
    const { resolveClaudeRequestedAccount } = wiring([{ id: 'auto-1' }])
    expect(await resolveClaudeRequestedAccount(recordIn('ws-auto'))).toEqual({
      kind: 'managed',
      accountId: 'a1'
    })
    expect(seen[0]).toMatchObject({ automationId: 'auto-1', workspaceId: 'ws-auto' })
  })

  it('leaves a chat that is neither a bot nor an automation on the host selection', async () => {
    const { resolveClaudeRequestedAccount } = wiring([
      { id: 'auto-1', account: 'home@example.com' }
    ])
    expect(await resolveClaudeRequestedAccount(recordIn('ws-plain'))).toBeNull()
  })
})
