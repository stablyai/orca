import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotToolServer } from '../../shared/bot-tools'

const mocks = vi.hoisted(() => {
  const servers: unknown[] = []
  return { servers, launched: vi.fn(), claudeCheck: vi.fn() }
})
vi.mock('./bot-tools-file', () => ({ readBotToolServers: async () => mocks.servers }))
vi.mock('./bot-launch-tools', () => ({
  cliWithLaunchTools: async (cli: unknown, servers: readonly BotToolServer[]) => {
    mocks.launched(servers.map((server) => server.name))
    return { cli, tools: { servers } }
  },
  withRelayProblems: (_cli: unknown, _servers: unknown, problems: unknown) => problems
}))
vi.mock('./bot-tools-claude-check', () => ({ claudeBotToolProblems: mocks.claudeCheck }))

import { botToolProblems, type BotToolsCli } from './bot-tools-host'

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

describe('checking a bot’s URL servers only', () => {
  beforeEach(() => {
    mocks.launched.mockReset()
    mocks.claudeCheck.mockReset().mockResolvedValue(new Map([['vercel', { kind: 'sign-in' }]]))
  })

  it('starts no command, and nothing at all for a bot with only commands', async () => {
    mocks.servers.splice(0, Infinity, { name: 'metrics', command: 'node', args: ['metrics.js'] })
    expect(await botToolProblems(cli, { remote: true })).toEqual({})
    expect(mocks.launched).not.toHaveBeenCalled()
    expect(mocks.claudeCheck).not.toHaveBeenCalled()

    mocks.servers.push({ name: 'vercel', url: 'https://mcp.vercel.com' })
    expect(await botToolProblems(cli, { remote: true })).toEqual({ vercel: { kind: 'sign-in' } })
    expect(mocks.launched).toHaveBeenCalledWith(['vercel'])
  })
})
