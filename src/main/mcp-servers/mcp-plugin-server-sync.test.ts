import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import { botToolsPath } from '../bots/bot-tools-file'
import { botToolsEpoch } from '../bots/bot-tools-revision'
import {
  listMcpServers,
  removeMcpServer,
  setMcpServerAgentEnabled,
  setMcpServerWorkspaces,
  updateMcpServer
} from './mcp-host-list'
import { addMcpServers } from './mcp-host-list-add'
import { syncPluginMcpServers, type PluginMcpServer } from './mcp-plugin-server-sync'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => useBotToolCredentialsRoot(tempDir('mcp-plugin-credentials-')))
afterEach(() => {
  useBotToolCredentialsRoot(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const fromPlugin = (args: string[]): PluginMcpServer => ({
  pluginKey: 'acme.toolkit',
  pluginName: 'Acme Toolkit',
  server: { name: 'acme', command: 'npx', args }
})

const only = (...declared: PluginMcpServer[]) => ({ declared, held: new Set<string>() })

it('keeps the user’s switches across plugin updates, writes nothing unchanged, and leaves their own servers alone', async () => {
  const folder = tempDir('mcp-plugin-servers-')
  const [yours] = await addMcpServers(
    [{ name: 'acme', command: 'acme-mcp', args: [] }],
    { nameGiven: true },
    folder
  )

  expect((await syncPluginMcpServers(only(fromPlugin(['-y', 'acme@1'])), {}, folder)).wrote).toBe(
    true
  )
  const added = (await listMcpServers(folder)).find((server) => server.plugin)
  expect(added).toMatchObject({
    name: 'acme-2',
    detail: 'npx -y acme@1',
    plugin: { key: 'acme.toolkit', name: 'Acme Toolkit' }
  })
  const id = added?.id ?? ''
  await setMcpServerAgentEnabled(id, 'codex', false, folder)
  const workspaces = { later: false, on: ['repo-1'], off: [] }
  await setMcpServerWorkspaces(id, workspaces, { folder })

  const text = readFileSync(botToolsPath(folder), 'utf8')
  const epoch = botToolsEpoch(folder)
  expect((await syncPluginMcpServers(only(fromPlugin(['-y', 'acme@1'])), {}, folder)).wrote).toBe(
    false
  )
  expect(readFileSync(botToolsPath(folder), 'utf8')).toBe(text)
  expect(botToolsEpoch(folder)).toBe(epoch)

  expect((await syncPluginMcpServers(only(fromPlugin(['-y', 'acme@2'])), {}, folder)).wrote).toBe(
    true
  )
  expect((await listMcpServers(folder)).find((server) => server.id === id)).toMatchObject({
    name: 'acme-2',
    detail: 'npx -y acme@2',
    agentsOff: ['codex'],
    workspaces
  })

  const edit = { name: 'acme-2', command: 'evil', args: [], env: [] }
  await expect(updateMcpServer(id, 'f'.repeat(64), edit, {}, folder)).rejects.toMatchObject({
    code: 'mcp_server_from_plugin'
  })
  await expect(removeMcpServer(id, folder)).rejects.toMatchObject({
    code: 'mcp_server_from_plugin'
  })

  // An update waiting for review holds the entry as approved; losing the plugin removes it.
  expect(
    (await syncPluginMcpServers({ declared: [], held: new Set(['acme.toolkit']) }, {}, folder))
      .wrote
  ).toBe(false)
  expect((await syncPluginMcpServers(only(), {}, folder)).wrote).toBe(true)
  expect(await listMcpServers(folder)).toEqual([yours])
})
