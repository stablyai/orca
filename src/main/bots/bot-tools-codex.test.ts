import { describe, expect, it } from 'vitest'
import { codexBotToolsThreadConfig, codexToolProblems } from './bot-tools-codex'
import { BotLaunchTools } from './bot-launch-tools'

const notion = { name: 'notion', url: 'https://mcp.notion.com/mcp' }
const time = { name: 'time', command: 'uvx', args: ['mcp-server-time'] }

describe("a Codex bot's tools", () => {
  it('adds its servers to a thread by dotted keys, which keep the owner’s own', async () => {
    const tools = await BotLaunchTools.for(
      { grant: async () => ({ origin: '', token: '' }) },
      { botId: 'b', folder: '/b', agent: 'codex' },
      [notion, time]
    )
    expect(codexBotToolsThreadConfig(tools)).toEqual({
      'mcp_servers.notion.url': 'https://mcp.notion.com/mcp',
      'mcp_servers.time.command': 'uvx',
      'mcp_servers.time.args': ['mcp-server-time']
    })
  })

  it("reads app-server's status as a sign-in or a failure, and a working tool as nothing", () => {
    const answer = {
      data: [
        { name: 'notion', runtimeStatus: 'authenticationRequired', toolsError: 'not logged in' },
        { name: 'time', runtimeStatus: 'failed', toolsError: 'spawn uvx ENOENT' },
        { name: 'ok', runtimeStatus: 'connected', toolsError: null },
        { name: 'owner', runtimeStatus: 'failed' }
      ]
    }
    expect(Object.fromEntries(codexToolProblems(answer, ['notion', 'time', 'ok']))).toEqual({
      notion: { kind: 'sign-in' },
      time: { kind: 'failed', detail: 'spawn uvx ENOENT' }
    })
  })
  it('requires affirmative native state, including while authentication finishes', () => {
    expect(Object.fromEntries(codexToolProblems({ data: [] }, ['docs']))).toEqual({
      docs: { kind: 'unconfirmed' }
    })
    expect(
      Object.fromEntries(
        codexToolProblems({ data: [{ name: 'docs', runtimeStatus: 'connecting' }] }, ['docs'])
      )
    ).toEqual({ docs: { kind: 'unconfirmed' } })
    expect(Object.fromEntries(codexToolProblems({ malformed: true }, ['docs']))).toEqual({
      docs: { kind: 'unconfirmed' }
    })
  })
})
