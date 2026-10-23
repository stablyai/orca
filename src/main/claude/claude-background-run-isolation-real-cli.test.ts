import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { claudeBackgroundArgs } from '../../shared/claude-background-run-isolation'
import { CLAUDE_MODEL_LIST_ARGS } from '../../shared/claude-model-list-probe'
import { realClaudeAvailable, realClaudeCommand } from './claude-real-cli-availability-test-support'

// Pins the contract with Claude itself: its `mcp_status` and `get_settings` answers (no turn spent)
// in a throwaway home whose own settings allowlist its user-scope server.
const root = mkdtempSync(join(tmpdir(), 'orca-claude-isolation-'))
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function loaded(args: string[]): Promise<{ servers: unknown; hooksOff: unknown }> {
  const request = (id: string) =>
    `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: id } })}\n`
  const { stdout } = await runProcess({
    program: realClaudeCommand,
    args,
    cwd: root,
    input: request('mcp_status') + request('get_settings'),
    timeoutMs: 60_000,
    env: withCliRuntimeOnPath(realClaudeCommand, {
      ...process.env,
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, 'config')
    })
  })
  const answers = new Map(
    stdout.split('\n').flatMap((line) => {
      const response = line.startsWith('{') ? JSON.parse(line).response : undefined
      return response?.request_id ? [[response.request_id, response.response]] : []
    })
  )
  return {
    servers: answers.get('mcp_status')?.mcpServers?.map((server: { name: string }) => server.name),
    hooksOff: answers.get('get_settings')?.effective?.disableAllHooks ?? false
  }
}

describe.skipIf(!realClaudeAvailable)('background Claude runs with the real CLI', () => {
  it('load none of the user MCP servers or hooks, and keep a --mcp-config the user passed', async () => {
    const server = { type: 'stdio', command: '/bin/cat', args: [] }
    mkdirSync(join(root, 'config'))
    writeFileSync(
      join(root, 'config', '.claude.json'),
      JSON.stringify({ mcpServers: { user: server } })
    )
    writeFileSync(
      join(root, 'config', 'settings.json'),
      JSON.stringify({ allowedMcpServers: [{ serverName: 'user' }, { serverName: 'explicit' }] })
    )
    writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { explicit: server } }))
    const listing = CLAUDE_MODEL_LIST_ARGS.slice(0, -claudeBackgroundArgs().length)

    expect(await loaded(listing)).toEqual({ servers: ['user'], hooksOff: false })
    expect(await loaded([...listing, ...claudeBackgroundArgs()])).toEqual({
      servers: [],
      hooksOff: true
    })
    expect(
      await loaded([...listing, ...claudeBackgroundArgs(), '--mcp-config', join(root, 'mcp.json')])
    ).toEqual({ servers: ['explicit'], hooksOff: true })
  }, 180_000)
})
