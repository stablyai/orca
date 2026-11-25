import { beforeEach, expect, it, vi } from 'vitest'
import type { BotLaunchTools } from './bot-launch-tools'
import { claudeStreamJsonExitError } from '../claude/sdk-transport/claude-stream-json-exit-error'
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

it('shares an in-flight Claude check, closes only that bot on stop, and can start again', async () => {
  const first = stuckConnection()
  const other = stuckConnection()
  const second = stuckConnection()
  mocks.open.mockResolvedValueOnce(first).mockResolvedValueOnce(other).mockResolvedValueOnce(second)
  const otherBot = { ...cli, botId: 'bot-2', folder: '/bots/two' }
  const check = (target: BotToolsCli) =>
    sharedBotToolHealthCheck(target.botId, 'claude\0remote', (signal) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only `servers`.
      claudeBotToolProblems(target, tools as BotLaunchTools, signal).then(Object.fromEntries)
    )

  const stopped = check(cli)
  const joined = check(cli)
  const independent = check(otherBot)
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2))
  cancelBotToolHealthChecks('bot-1')
  await expect(stopped).rejects.toMatchObject({ name: 'AbortError' })
  await expect(joined).rejects.toMatchObject({ name: 'AbortError' })
  expect(first.close).toHaveBeenCalled()
  expect(other.close).not.toHaveBeenCalled()

  // The next check opens its own connection, and stopping it closes that one too.
  const next = check(cli)
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(3))
  expect(second.close).not.toHaveBeenCalled()
  cancelBotToolHealthChecks('bot-1')
  await expect(next).rejects.toMatchObject({ name: 'AbortError' })
  expect(second.close).toHaveBeenCalled()

  cancelBotToolHealthChecks(otherBot.botId)
  await expect(independent).rejects.toMatchObject({ name: 'AbortError' })
  expect(other.close).toHaveBeenCalled()
})

it('marks every tool off with the reason when managed settings refuse them', async () => {
  const refusal = claudeStreamJsonExitError(
    "Error: --mcp-config is disabled by your organization's managed settings (disableSideloadFlags). Plugins, custom agents, and MCP servers can only be loaded from sources your administrator has approved.",
    { code: 1, signal: null, processless: false }
  )
  mocks.open.mockResolvedValueOnce({
    close: vi.fn(async () => true),
    mcpServerStatus: () => Promise.reject(refusal)
  })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only `servers`.
  const problems = await claudeBotToolProblems(cli, tools as BotLaunchTools)

  expect(Object.fromEntries(problems)).toEqual({
    vercel: {
      kind: 'failed',
      detail: "Off: your organization's Claude Code managed settings refuse MCP servers."
    }
  })
})
