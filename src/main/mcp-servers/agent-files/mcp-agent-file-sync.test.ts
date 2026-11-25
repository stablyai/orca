import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addMcpServer, setMcpAgentFileAllowed } from '../mcp-host-list'
import { McpAgentFileLedger } from './mcp-agent-file-ledger'
import { syncMcpAgentFiles, type McpAgentFileSyncDeps } from './mcp-agent-file-sync'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const read = (path: string): string => readFileSync(path, 'utf8')

const CURSOR_BEFORE = `{
  // the user's own
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  },
  "theme": "dark"
}`
const GROK_BEFORE = 'model = "grok-4"\r\n\r\n[mcp_servers.github]\r\ncommand = "gh-mcp"'

let previousSwitch: string | undefined
beforeEach(() => {
  previousSwitch = process.env.ORCA_MCP_SERVERS
  process.env.ORCA_MCP_SERVERS = '1'
})
afterEach(() => {
  if (previousSwitch === undefined) {
    delete process.env.ORCA_MCP_SERVERS
  } else {
    process.env.ORCA_MCP_SERVERS = previousSwitch
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function instance(folder: string, homeDir: string, userDataPath: string): McpAgentFileSyncDeps {
  return {
    folder,
    userDataPath,
    launcher: join(userDataPath, 'bin', 'orca'),
    context: { homeDir, env: {}, platform: 'darwin' },
    ledger: new McpAgentFileLedger(join(folder, '.orca', 'agent-files-ledger.json')),
    log: () => {}
  }
}

async function setUp() {
  const homeDir = tempDir('mcp-agent-files-home-')
  const folder = tempDir('mcp-agent-files-list-')
  const paths = {
    grok: join(homeDir, '.grok', 'config.toml'),
    cursor: join(homeDir, '.cursor', 'mcp.json'),
    droid: join(homeDir, '.factory', 'mcp.json')
  }
  mkdirSync(join(homeDir, '.grok'))
  mkdirSync(join(homeDir, '.cursor'))
  writeFileSync(paths.grok, GROK_BEFORE)
  writeFileSync(paths.cursor, CURSOR_BEFORE)
  const add = (name: string) =>
    addMcpServer({ name, command: 'npx', args: ['-y', name] }, { nameGiven: true }, folder)
  await add('postgres')
  await add('context7')
  return { homeDir, folder, paths }
}

describe("Orca's servers in Grok's, Cursor's and Droid's own MCP files", () => {
  it('withdrawing consent leaves each file as it was plus only the user’s own edits', async () => {
    const { homeDir, folder, paths } = await setUp()
    const app = instance(folder, homeDir, join(homeDir, 'orca'))
    for (const agent of ['grok', 'cursor', 'droid'] as const) {
      await setMcpAgentFileAllowed(agent, true, folder)
    }
    await syncMcpAgentFiles(app)

    const cursor = parse(read(paths.cursor))
    expect(cursor.mcpServers.postgres.args.slice(0, 2)).toEqual(['mcp', 'connect'])
    // A name the user already uses stays theirs.
    expect(cursor.mcpServers.context7.command).toBe('npx')
    expect(JSON.parse(read(paths.droid)).mcpServers.postgres.type).toBe('stdio')
    expect(read(paths.grok)).toContain('[mcp_servers.postgres]\r\n')

    // Another Orca (a dev build) keeps its own entries beside these, under its own names.
    const dev = instance(tempDir('mcp-agent-files-dev-'), homeDir, join(homeDir, 'orca-dev'))
    await addMcpServer(
      { name: 'linear', command: 'npx', args: ['-y', 'linear'] },
      { nameGiven: true },
      dev.folder
    )
    await setMcpAgentFileAllowed('cursor', true, dev.folder)
    await syncMcpAgentFiles(dev)

    // The user adds a server of their own after Orca's entries.
    const edited = read(paths.cursor).replace(
      '"theme": "dark"',
      '"theme": "light",\n  "editor": "vim"'
    )
    writeFileSync(paths.cursor, edited)

    for (const agent of ['grok', 'cursor', 'droid'] as const) {
      await setMcpAgentFileAllowed(agent, false, folder)
    }
    await syncMcpAgentFiles(app)

    expect(read(paths.grok)).toBe(GROK_BEFORE)
    expect(existsSync(paths.droid)).toBe(false)
    const after = parse(read(paths.cursor))
    expect(Object.keys(after.mcpServers).sort()).toEqual(['context7', 'linear-orca-dev'])
    expect(after.editor).toBe('vim')

    await setMcpAgentFileAllowed('cursor', false, dev.folder)
    await syncMcpAgentFiles(dev)
    expect(read(paths.cursor)).toBe(
      CURSOR_BEFORE.replace('"theme": "dark"', '"theme": "light",\n  "editor": "vim"')
    )
  })

  it('writes nothing while the MCP servers switch is off', async () => {
    const { homeDir, folder, paths } = await setUp()
    await setMcpAgentFileAllowed('cursor', true, folder)
    await setMcpAgentFileAllowed('droid', true, folder)
    delete process.env.ORCA_MCP_SERVERS
    await syncMcpAgentFiles(instance(folder, homeDir, join(homeDir, 'orca')))
    expect(read(paths.cursor)).toBe(CURSOR_BEFORE)
    expect(read(paths.grok)).toBe(GROK_BEFORE)
    expect(existsSync(paths.droid)).toBe(false)
  })
})
