import { expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_LINK_METHODS } from './bots-link'
import type { RpcContext } from '../core'

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    deps: {
      store: {
        getConversation: (id: string) =>
          id === 'bot-caller' ? { location: { workspaceId: 'folder:bot-home' } } : undefined
      }
    }
  })
}))

it('uses the caller’s bot and disallows another bot or an untrusted caller claim', async () => {
  const [method] = BOT_LINK_METHODS
  const bots = [
    makeTestBot({ id: 'scan-bot', folderWorkspaceId: 'bot-home' }),
    makeTestBot({ id: 'other-bot' })
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this workspace and bot authority are used by the handler.
  const runtime = {
    bots: { assertEnabled: () => {}, list: () => bots },
    showManagedWorktree: async (_selector: string, hostId: string) => {
      if (hostId !== 'local') {
        throw new Error('Unexpected workspace authority')
      }
      return { id: 'repo-id::/workspaces/scan', displayName: 'scan' }
    }
  } as unknown as RpcContext['runtime']
  const params = {
    worktree: 'id:repo-id::/workspaces/scan',
    callerSessionId: 'bot-caller',
    agentSessionId: 'orca_session_id:scan-session'
  }
  await expect(method.handler(params, { runtime })).resolves.toEqual({
    link: 'orca://bot/scan-bot?workspace=repo-id%3A%3A%2Fworkspaces%2Fscan&agent=scan-session',
    workspaceName: 'scan'
  })
  await expect(method.handler({ ...params, botId: 'other-bot' }, { runtime })).rejects.toThrow(
    'A bot can reach only its own work.'
  )
  await expect(
    method.handler({ ...params, callerSessionId: 'not-a-bot' }, { runtime })
  ).rejects.toThrow('Name the bot with --bot')
  await expect(method.handler(params, { runtime, pairedDeviceId: 'device' })).rejects.toThrow(
    'Name the bot with --bot'
  )
})
