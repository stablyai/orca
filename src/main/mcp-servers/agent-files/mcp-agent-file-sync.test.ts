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

/** The keys of Orca's entries for `server` (named `<server>-<folder>-<hash>`). */
const serverKeys = (file: { mcpServers: Record<string, unknown> }, server: string): string[] =>
  Object.keys(file.mcpServers).filter((name) => name.startsWith(`${server}-orca-`))

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
    const app = instance(folder, homeDir, join(homeDir, 'one', 'orca'))
    for (const agent of ['grok', 'cursor', 'droid'] as const) {
      await setMcpAgentFileAllowed(agent, true, folder)
    }
    await syncMcpAgentFiles(app)

    const cursor = parse(read(paths.cursor))
    const ours = serverKeys(cursor, 'postgres')
    expect(ours).toHaveLength(1)
    expect(cursor.mcpServers[ours[0]!].args.slice(0, 2)).toEqual(['mcp', 'connect'])
    // A server the user already keeps in the agent under its own name runs from there.
    expect(Object.keys(cursor.mcpServers).filter((name) => name.startsWith('context7'))).toEqual([
      'context7'
    ])
    const droid = JSON.parse(read(paths.droid))
    expect(droid.mcpServers[serverKeys(droid, 'postgres')[0]!].type).toBe('stdio')
    expect(read(paths.grok)).toMatch(/\[mcp_servers\.postgres-orca-[0-9a-f]+\]\r\n/)

    // Another profile, whose folder is also called `orca`, keeps its own same-named server beside.
    const other = instance(tempDir('mcp-agent-files-other-'), homeDir, join(homeDir, 'two', 'orca'))
    await addMcpServer(
      { name: 'postgres', command: 'npx', args: ['-y', 'postgres'] },
      { nameGiven: true },
      other.folder
    )
    await setMcpAgentFileAllowed('cursor', true, other.folder)
    await syncMcpAgentFiles(other)
    expect(serverKeys(parse(read(paths.cursor)), 'postgres')).toHaveLength(2)

    // The user adds a setting of their own after Orca's entries.
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
    const left = serverKeys(after, 'postgres')
    expect(left).toHaveLength(1)
    expect(after.mcpServers[left[0]!].env.ORCA_USER_DATA_PATH).toBe(join(homeDir, 'two', 'orca'))
    expect(after.editor).toBe('vim')

    await setMcpAgentFileAllowed('cursor', false, other.folder)
    await syncMcpAgentFiles(other)
    expect(read(paths.cursor)).toBe(
      CURSOR_BEFORE.replace('"theme": "dark"', '"theme": "light",\n  "editor": "vim"')
    )
  })

  it('renames entries an earlier Orca wrote under the plain server name on the next sync', async () => {
    const { homeDir, folder, paths } = await setUp()
    const app = instance(folder, homeDir, join(homeDir, 'orca'))
    await setMcpAgentFileAllowed('cursor', true, folder)
    await syncMcpAgentFiles(app)
    // What the earlier naming left: the same entry, and the ledger's record of it, as `postgres`.
    const [name] = serverKeys(parse(read(paths.cursor)), 'postgres')
    const ledgerPath = join(folder, '.orca', 'agent-files-ledger.json')
    writeFileSync(paths.cursor, read(paths.cursor).replace(`"${name}"`, '"postgres"'))
    writeFileSync(ledgerPath, read(ledgerPath).replaceAll(`\\"${name}\\"`, '\\"postgres\\"'))
    writeFileSync(ledgerPath, read(ledgerPath).replace(`"${name}"`, '"postgres"'))
    // ...and the user has edited the file since, so only the ledger's copy of the entry tells it apart.
    writeFileSync(paths.cursor, read(paths.cursor).replace('"dark"', '"light"'))

    await syncMcpAgentFiles(app)
    const renamed = parse(read(paths.cursor))
    expect(Object.keys(renamed.mcpServers)).toEqual(['context7', name])

    await setMcpAgentFileAllowed('cursor', false, folder)
    await syncMcpAgentFiles(app)
    expect(read(paths.cursor)).toBe(CURSOR_BEFORE.replace('"dark"', '"light"'))
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
