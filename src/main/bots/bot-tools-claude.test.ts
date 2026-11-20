import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeMirrorArgs,
  claudeMirrorChanges,
  claudeServerConfig,
  claudeToolProblems,
  readClaudeInheritedTools,
  readClaudeMirror
} from './bot-tools-claude'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const notion = { name: 'notion', url: 'https://mcp.notion.com/mcp' }
const time = { name: 'time', command: 'uvx', args: ['mcp-server-time'], env: { TZ: 'UTC' } }

describe("a Claude Code bot's tools", () => {
  it("reads the owner's servers and plugins it inherits, and the sign-in folder's mirror", async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'bot-tools-claude-'))
    dirs.push(configDir)
    const signIn = join(configDir, 'bot-tool-sign-in', 'bot-1')
    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { github: { command: 'gh-mcp' } },
        projects: { [signIn]: { mcpServers: { notion: { type: 'http', url: notion.url } } } }
      })
    )
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'visuals@orca': true, 'off@orca': false } })
    )
    expect(await readClaudeInheritedTools(configDir)).toEqual([
      { name: 'github' },
      { name: 'visuals', plugin: true }
    ])
    const mirror = await readClaudeMirror(configDir, signIn)
    // Only what is missing, or saved with another config, is mirrored again.
    expect(claudeMirrorChanges(mirror, [notion, time])).toEqual([time])
    expect(
      claudeMirrorChanges(mirror, [{ ...notion, url: 'https://other.example/mcp' }])
    ).toHaveLength(1)
  })

  it('passes a server to Claude’s local mirror as one JSON argument', () => {
    expect(claudeMirrorArgs(time)).toEqual([
      'mcp',
      'add-json',
      '--scope',
      'local',
      'time',
      JSON.stringify({
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-time'],
        env: { TZ: 'UTC' }
      })
    ])
  })

  it("reads each tool's problem from `claude mcp list`, as the real CLI prints it", () => {
    const listing = [
      'Checking MCP server health…',
      '',
      'spike3: http://127.0.0.1:47811/mcp (HTTP) - ! Needs authentication',
      "broken: /nonexistent/bin  - ✘ Failed to connect — ENOENT: no such file or directory, posix_spawn '/nonexistent/bin'",
      'fine: https://example.com/mcp (HTTP) - ✓ Connected',
      'starting: node server - Pending',
      'github: gh-mcp  - ✘ Failed to connect'
    ].join('\n')
    const names = ['spike3', 'broken', 'fine', 'starting', 'missing']
    expect(Object.fromEntries(claudeToolProblems(listing, names))).toEqual({
      spike3: { kind: 'sign-in' },
      broken: {
        kind: 'failed',
        detail:
          "Failed to connect — ENOENT: no such file or directory, posix_spawn '/nonexistent/bin'"
      },
      starting: { kind: 'unconfirmed' },
      missing: { kind: 'unconfirmed' }
    })
  })

  it('starts an npm launcher through cmd on Windows, where it is a .cmd shim', () => {
    const server = { name: 'notion', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }
    expect(claudeServerConfig(server, 'win32')).toEqual({
      type: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@notionhq/notion-mcp-server']
    })
    expect(claudeServerConfig(server, 'darwin')).toMatchObject({ command: 'npx' })
    // cmd would end the command at & and expand %VAR%; mcp-remote URLs carry both.
    const remote = {
      name: 'remote',
      command: 'npx',
      args: ['mcp-remote', 'https://x.example/mcp?a=1&b=%TEMP%|(c)', 'with space & more']
    }
    expect(claudeServerConfig(remote, 'win32')).toMatchObject({
      args: [
        '/c',
        'npx',
        'mcp-remote',
        'https://x.example/mcp?a=1^^^&b=^^^%TEMP^^^%^^^|^^^(c^^^)',
        'with space & more'
      ]
    })
    expect(claudeServerConfig(remote, 'darwin')).toMatchObject({ args: remote.args })
    expect(claudeServerConfig({ ...server, command: 'uvx' }, 'win32')).toMatchObject({
      command: 'uvx'
    })
  })
})
