import { describe, expect, it } from 'vitest'
import { botToolServerOf } from './bots-tools'

describe('a pasted tool', () => {
  it('reads a URL as a remote server and anything else as the command that starts one', () => {
    expect(botToolServerOf('https://mcp.notion.com/mcp')).toEqual({
      name: 'notion',
      url: 'https://mcp.notion.com/mcp'
    })
    expect(botToolServerOf('npx -y "@notionhq/notion-mcp-server"', 'docs')).toEqual({
      name: 'docs',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server']
    })
  })
})
