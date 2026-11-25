import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { readBotToolCredential, useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import { botToolsPath, changeBotToolServers } from '../bots/bot-tools-file'
import { darkSwitchRuntimeCapabilities } from '../runtime/construction/dark-switch-runtime-capabilities'
import {
  addMcpServer,
  listMcpServers,
  mcpServerDetails,
  setMcpServerAgentEnabled,
  setMcpServerWorkspaces,
  updateMcpServer
} from './mcp-host-list'
import { assertMcpServersFeatureEnabled } from './mcp-servers-feature'

const SECRET = 'sk-live-secret-value'
const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const stored = (folder: string) => JSON.parse(readFileSync(botToolsPath(folder), 'utf8'))

beforeEach(() => {
  useBotToolCredentialsRoot(tempDir('mcp-host-credentials-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/, '$1'),
    describeProtectionGap: () => null
  })
})
afterEach(() => {
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  delete process.env.ORCA_MCP_SERVERS
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("a host's MCP server list", () => {
  it('keeps each server’s id, agents and workspaces through edits, and its header value sealed', async () => {
    const folder = tempDir('mcp-host-list-')
    const added = await addMcpServer(
      {
        name: 'sentry',
        url: 'https://mcp.sentry.dev/mcp',
        transport: 'http',
        headers: { authorization: SECRET }
      },
      { nameGiven: true },
      folder
    )
    await setMcpServerAgentEnabled(added.id, 'grok', false, folder)
    const workspaces = { later: false, on: ['repo-1', 'folder:notes'], off: ['repo-2'] }
    await setMcpServerWorkspaces(added.id, workspaces, folder)
    // A bot-tools write that knows nothing of these keys keeps them.
    await changeBotToolServers(folder, (servers) => [...servers])
    const { version } = await mcpServerDetails(added.id, folder)
    await updateMcpServer(
      added.id,
      version,
      {
        name: 'sentry-work',
        url: 'https://mcp.sentry.dev/mcp',
        transport: 'http',
        headers: [{ key: 'authorization', keep: true }]
      },
      folder
    )

    expect(await listMcpServers(folder)).toEqual([
      expect.objectContaining({
        id: added.id,
        name: 'sentry-work',
        agentsOff: ['grok'],
        workspaces,
        sharedProcess: false
      })
    ])
    const [entry] = stored(folder).servers
    expect(JSON.stringify(stored(folder))).not.toContain(SECRET)
    expect(readBotToolCredential(folder, entry.credential)?.headers).toEqual({
      authorization: SECRET
    })
  })

  it('gives a hand-edited entry an id once, and a server whose workspaces it can’t read is on nowhere', async () => {
    const folder = tempDir('mcp-host-list-')
    mkdirSync(join(folder, '.orca'), { recursive: true })
    writeFileSync(
      botToolsPath(folder),
      JSON.stringify({
        servers: [
          { name: 'pg', command: 'npx', args: ['server-postgres'], workspaces: { later: 'yes' } },
          { name: 'docs', command: 'docs-mcp', args: [] }
        ]
      })
    )

    const [pg, docs] = await listMcpServers(folder)
    expect(pg?.workspaces).toEqual({ later: false, on: [], off: [] })
    expect(docs?.workspaces).toEqual({ later: true, on: [], off: [] })
    expect(stored(folder).servers.map((server: { id: string }) => server.id)).toEqual([
      pg?.id,
      docs?.id
    ])
    expect((await listMcpServers(folder)).map((server) => server.id)).toEqual([pg?.id, docs?.id])
  })
})

describe('the MCP servers switch', () => {
  it('advertises nothing and refuses every call while off', () => {
    expect(darkSwitchRuntimeCapabilities()).not.toContain('mcp-servers.v1')
    expect(assertMcpServersFeatureEnabled).toThrow(
      expect.objectContaining({ code: 'mcp_servers_off' })
    )

    process.env.ORCA_MCP_SERVERS = '1'
    expect(darkSwitchRuntimeCapabilities()).toContain('mcp-servers.v1')
    expect(assertMcpServersFeatureEnabled).not.toThrow()
  })
})
