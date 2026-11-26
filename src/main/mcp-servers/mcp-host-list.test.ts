import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import {
  changeBotToolCredentials,
  readBotToolCredential,
  useBotToolCredentialsRoot
} from '../bots/bot-tool-credentials'
import { botToolsPath, changeBotToolServers } from '../bots/bot-tools-file'
import {
  BotToolRelay,
  MCP_HOST_LIST_RELAY_OWNER,
  relayToolUrl
} from '../bots/tool-relay/bot-tool-relay'
import {
  call,
  closeUpstreams,
  json,
  upstream
} from '../bots/tool-relay/bot-tool-relay.test-fixtures'
import {
  listMcpServers,
  mcpServerDetails,
  readMcpHostList,
  removeMcpServer,
  setMcpAgentFileAllowed,
  setMcpServerAgentEnabled,
  setMcpServerWorkspaces,
  updateMcpServer
} from './mcp-host-list'
import { addMcpServers } from './mcp-host-list-add'

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
  closeUpstreams()
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("a host's MCP server list", () => {
  // A repo's "Add a server for this repo": a second call to limit it could fail and leave it on everywhere.
  it('stores the workspaces an add names with the server, in the same write', async () => {
    const folder = tempDir('mcp-host-list-')
    const onlyHere = { later: false, on: ['repo-1'], off: [] }
    const [added] = await addMcpServers(
      [{ name: 'postgres', command: 'npx', args: ['-y', 'server-postgres'] }],
      { nameGiven: true, workspaces: onlyHere },
      folder
    )
    expect(added.workspaces).toEqual(onlyHere)
    expect((await listMcpServers(folder))[0]?.workspaces).toEqual(onlyHere)
  })

  it('keeps each server’s id, agents and workspaces and the agent-file consent through edits, and header values sealed', async () => {
    const folder = tempDir('mcp-host-list-')
    const [added] = await addMcpServers(
      [
        {
          name: 'sentry',
          url: 'https://mcp.sentry.dev/mcp',
          transport: 'http',
          headers: { authorization: SECRET }
        }
      ],
      { nameGiven: true },
      folder
    )
    await setMcpServerAgentEnabled(added.id, 'grok', false, folder)
    await setMcpAgentFileAllowed('cursor', true, folder)
    const { version } = await mcpServerDetails(added.id, folder)
    // A switch flipped while the editor is open doesn't make its save stale.
    const workspaces = { later: false, on: ['repo-1', 'folder:notes'], off: ['repo-2'] }
    await setMcpServerWorkspaces(added.id, workspaces, { folder })
    // A bot-tools write that knows nothing of these keys keeps them.
    await changeBotToolServers(folder, (servers) => [...servers])
    const updated = await updateMcpServer(
      added.id,
      version,
      {
        name: 'sentry-work',
        url: 'https://mcp.sentry.dev/mcp',
        transport: 'http',
        headers: [{ key: 'authorization', keep: true }]
      },
      {},
      folder
    )

    // The answer is the stored row: its headers went to the store, so the relay signs it in.
    expect(updated.remote).toBe(false)
    expect(await listMcpServers(folder)).toEqual([
      expect.objectContaining({
        id: added.id,
        name: 'sentry-work',
        agentsOff: ['grok'],
        workspaces,
        sharedProcess: false
      })
    ])
    expect((await readMcpHostList(folder)).agentFiles).toEqual({
      grok: false,
      cursor: true,
      droid: false
    })
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

  // Two editors open on "All workspaces": each saves its own exclusion from what it was showing.
  it('keeps an exclusion another editor saved while this one still showed the old choice', async () => {
    const folder = tempDir('mcp-host-list-')
    const [added] = await addMcpServers(
      [{ name: 'postgres', command: 'npx', args: ['-y', 'server-postgres'] }],
      { nameGiven: true },
      folder
    )
    const shown = { later: true, on: [], off: [] }
    await setMcpServerWorkspaces(
      added.id,
      { later: true, on: [], off: ['repo-x'] },
      { base: shown, folder }
    )
    const saved = await setMcpServerWorkspaces(
      added.id,
      { later: true, on: [], off: ['repo-y'] },
      { base: shown, folder }
    )
    expect(saved.workspaces).toEqual({ later: true, on: [], off: ['repo-x', 'repo-y'] })
  })
})

// The phone's and desktop's Remove confirms say what goes; these hold the host to those words.
describe('removing a server from the host list', () => {
  /** A host list naming each server's credential, with fixture header values saved for each id. */
  function hostWith(servers: { name: string; url: string; credential: string }[]): string {
    const folder = tempDir('mcp-host-list-')
    mkdirSync(join(folder, '.orca'), { recursive: true })
    for (const { url, credential } of servers) {
      changeBotToolCredentials(
        folder,
        new Map([[credential, { url, headers: { 'x-example-key': SECRET } }]])
      )
    }
    writeFileSync(botToolsPath(folder), JSON.stringify({ servers }))
    return folder
  }

  it('deletes the saved values only it names, keeping ones another server still names', async () => {
    const url = 'https://mcp.example.test/mcp'
    const folder = hostWith([
      { name: 'example-a', url, credential: 'cred-shared' },
      { name: 'example-b', url, credential: 'cred-shared' },
      { name: 'example-c', url, credential: 'cred-own' }
    ])
    const [a, , c] = await listMcpServers(folder)

    await removeMcpServer(a?.id ?? '', folder)
    expect(readBotToolCredential(folder, 'cred-shared')?.headers).toEqual({
      'x-example-key': SECRET
    })
    await removeMcpServer(c?.id ?? '', folder)
    expect(readBotToolCredential(folder, 'cred-own')).toBeNull()
  })

  it('cuts a running session’s calls through the relay at once, not only new sessions', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    const folder = hostWith([{ name: 'example', url: tool.url, credential: 'cred-example' }])
    const relay = new BotToolRelay((target, init) => fetch(target, init))
    try {
      const { origin, token } = await relay.grant(MCP_HOST_LIST_RELAY_OWNER, {
        host: folder
      })
      const session = (): ReturnType<typeof call> =>
        call(relayToolUrl(origin, 'host', 'cred-example'), {
          headers: { ...json, authorization: `Bearer ${token}` },
          body: '{}'
        })
      expect((await session()).status).toBe(200)

      const [server] = await listMcpServers(folder)
      await removeMcpServer(server?.id ?? '', folder)
      expect((await session()).status).toBe(404)
      expect(tool.seen).toHaveLength(1)
    } finally {
      relay.close()
    }
  })
})
