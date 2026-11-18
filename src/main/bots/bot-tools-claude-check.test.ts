import { beforeEach, expect, it, vi } from 'vitest'
import type { BotLaunchTools } from './bot-launch-tools'
import type { BotToolsCli } from './bot-tools-host'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../claude/claude-stream-json-connection', () => ({
  openClaudeStreamJsonConnection: mocks.open
}))
vi.mock('./bot-tools-claude', () => ({ claudeLaunchServers: () => ({}) }))

import { claudeBotToolProblems } from './bot-tools-claude-check'
import { cancelBotToolHealthChecks, sharedBotToolHealthCheck } from './bot-tool-health-checks'

const cli: BotToolsCli = {
  botId: 'bot-1',
  agent: 'claude',
  folder: '/bots/one',
  signInFolder: '/sign-in/one',
  command: 'claude',
  prefixArgs: [],
  env: {},
  accountHome: null,
  otherBotFolders: []
}
const tools: Pick<BotLaunchTools, 'servers'> = {
  servers: [{ name: 'vercel', url: 'https://mcp.vercel.com' }]
}

/** A connection whose status request never answers; closing it fails the request, as the CLI's does. */
function stuckConnection() {
  let fail: (error: Error) => void = () => {}
  const close = vi.fn(async () => {
    fail(new Error('claude stream-json connection closed'))
    return true
  })
  return {
    close,
    mcpServerStatus: () =>
      new Promise<never>((_resolve, reject) => {
        fail = reject
      })
  }
}

beforeEach(() => mocks.open.mockReset())

it('closes the Claude CLI as soon as its check is stopped, its status request still unanswered', async () => {
  const first = stuckConnection()
  const second = stuckConnection()
  mocks.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const check = () =>
    sharedBotToolHealthCheck('bot-1', 'claude\0remote', (signal) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only `servers`.
      claudeBotToolProblems(cli, tools as BotLaunchTools, signal).then(Object.fromEntries)
    )

  const stopped = check()
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
  cancelBotToolHealthChecks('bot-1')
  await expect(stopped).rejects.toBeDefined()
  expect(first.close).toHaveBeenCalled()

  // The next check opens its own connection, and stopping it closes that one too.
  const next = check()
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2))
  expect(second.close).not.toHaveBeenCalled()
  cancelBotToolHealthChecks('bot-1')
  await expect(next).rejects.toBeDefined()
  expect(second.close).toHaveBeenCalled()
})
