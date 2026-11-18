import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBotToolCredential, useBotToolCredentialsRoot } from './bot-tool-credentials'
import {
  botOwnTool,
  botToolsPath,
  changeBotToolServers,
  readBotToolServers,
  writeBotToolServers
} from './bot-tools-file'
import { readBotToolDetails, resolveBotToolInput } from './bot-tool-details'
import { updateBotTool, type BotToolsCli } from './bot-tools-host'
import { claudeLaunchServers, claudeMirrorChanges } from './bot-tools-claude'
import { codexBotToolsThreadConfig } from './bot-tools-codex'
import { redactBotToolProblems } from './bot-tool-redaction'
import { BotLaunchTools } from './bot-launch-tools'
import type { BotToolInput } from '../../shared/bot-tools'

const dirs: string[] = []
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-tool-credentials-'))
  dirs.push(root)
  useBotToolCredentialsRoot(root)
})
afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'bot-tool-details-'))
  dirs.push(folder)
  const cli: BotToolsCli = {
    botId: 'isolated',
    agent: 'codex',
    folder,
    signInFolder: join(folder, 'sign-in'),
    command: 'unused',
    prefixArgs: [],
    env: {},
    accountHome: folder,
    otherBotFolders: []
  }
  await writeBotToolServers(folder, [
    {
      name: 'docs',
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'synthetic-secret', 'X-Remove': 'synthetic-remove' }
    }
  ])
  return cli
}
const input = (): Extract<BotToolInput, { url: string }> => ({
  name: 'docs',
  url: 'https://docs.example/new-path',
  transport: 'http',
  headers: [
    { key: 'Authorization', keep: true },
    { key: 'X-New', value: 'replacement' }
  ]
})

describe('saved own tool details', () => {
  it('returns only configured keys, keeps/replaces/removes values and preserves unknown data across rename', async () => {
    const cli = await fixture()
    const raw = JSON.parse(await readFile(botToolsPath(cli.folder), 'utf8'))
    raw.future = { untouched: true }
    raw.servers[0].futureOption = { nested: 42 }
    await writeFile(botToolsPath(cli.folder), JSON.stringify(raw))
    const details = await readBotToolDetails(cli.folder, 'docs')
    expect(JSON.stringify(details)).not.toContain('synthetic-')
    expect(details.server).toMatchObject({
      headers: [
        { key: 'Authorization', configured: true },
        { key: 'X-Remove', configured: true }
      ]
    })
    const change = input()
    change.name = 'renamed'
    await updateBotTool(cli, 'docs', details.version, change)
    const text = await readFile(botToolsPath(cli.folder), 'utf8')
    expect(text).not.toContain('synthetic-')
    const saved = JSON.parse(text)
    expect(saved).toEqual({
      future: { untouched: true },
      servers: [
        {
          name: 'renamed',
          url: 'https://docs.example/new-path',
          transport: 'http',
          credential: expect.any(String),
          futureOption: { nested: 42 }
        }
      ]
    })
    expect(readBotToolCredential(cli.folder, saved.servers[0].credential)).toEqual({
      url: 'https://docs.example/new-path',
      headers: { Authorization: 'synthetic-secret', 'X-New': 'replacement' }
    })
    expect(
      JSON.stringify(botOwnTool((await readBotToolServers(cli.folder))[0]!, cli.folder))
    ).not.toContain('synthetic-')
  })
  it('rejects stale writes, unknown saved keys, invalid headers, duplicates and inherited edits', async () => {
    const cli = await fixture()
    const details = await readBotToolDetails(cli.folder, 'docs')
    await updateBotTool(cli, 'docs', details.version, input())
    await expect(updateBotTool(cli, 'docs', details.version, input())).rejects.toThrow('changed')
    await expect(readBotToolDetails(cli.folder, 'inherited')).rejects.toThrow('no longer')
    const previous = (await readBotToolServers(cli.folder))[0]!
    for (const headers of [
      [{ key: 'Unknown', keep: true as const }],
      [{ key: 'Bad Header', value: 'x' }],
      [
        { key: 'X', value: 'one' },
        { key: 'x', value: 'two' }
      ],
      [{ key: 'X', value: 'a\r\nb' }]
    ]) {
      expect(() => resolveBotToolInput({ ...input(), headers }, previous)).toThrow()
    }
  })
  it('requires re-entry across URL origin or executable changes, and removes inactive mode fields', async () => {
    const cli = await fixture()
    const details = await readBotToolDetails(cli.folder, 'docs')
    const changed = { ...input(), url: 'https://other.example/mcp' }
    await expect(updateBotTool(cli, 'docs', details.version, changed)).rejects.toThrow(
      'destination changed'
    )
    await updateBotTool(cli, 'docs', details.version, {
      name: 'docs',
      command: '/tools/mcp',
      args: ['two words', '', ' edge '],
      env: [{ key: 'TOKEN', value: 'new-secret' }]
    })
    const server = (await readBotToolServers(cli.folder))[0]!
    expect(server).toEqual({
      name: 'docs',
      command: '/tools/mcp',
      args: ['two words', '', ' edge '],
      env: { TOKEN: 'new-secret' }
    })
    expect(() =>
      resolveBotToolInput(
        { name: 'docs', command: '/other/mcp', args: [], env: [{ key: 'TOKEN', keep: true }] },
        server
      )
    ).toThrow('destination changed')
    expect(() =>
      resolveBotToolInput(
        {
          name: 'docs',
          command: '/tools/mcp',
          args: [],
          env: [
            { key: 'Token', value: 'x' },
            { key: 'TOKEN', value: 'y' }
          ]
        },
        server,
        'win32'
      )
    ).toThrow('unique')
  })
  it('refuses a renamed collision and malformed storage without overwriting anything', async () => {
    const cli = await fixture()
    await writeBotToolServers(cli.folder, [
      ...(await readBotToolServers(cli.folder)),
      { name: 'other', command: 'node', args: [] }
    ])
    const details = await readBotToolDetails(cli.folder, 'docs')
    await expect(
      updateBotTool(cli, 'docs', details.version, { ...input(), name: 'other' })
    ).rejects.toThrow('already')
    await writeFile(botToolsPath(cli.folder), '{broken')
    await expect(writeBotToolServers(cli.folder, [])).rejects.toThrow('invalid')
    expect(await readFile(botToolsPath(cli.folder), 'utf8')).toBe('{broken')
  })
  it('allows only one simultaneous edit against a saved version', async () => {
    const cli = await fixture()
    const details = await readBotToolDetails(cli.folder, 'docs')
    const results = await Promise.allSettled([
      updateBotTool(cli, 'docs', details.version, { ...input(), url: 'https://docs.example/one' }),
      updateBotTool(cli, 'docs', details.version, { ...input(), url: 'https://docs.example/two' })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('hands both adapters the relay for saved headers, exact argv/env, and remirrors removed credentials', async () => {
    const remote = resolveBotToolInput({
      name: 'docs',
      url: 'https://docs.example/mcp',
      transport: 'http',
      headers: [{ key: 'Authorization', value: 'synthetic' }]
    })
    const command = resolveBotToolInput({
      name: 'local',
      command: 'node',
      args: ['two words', '', ' edge '],
      env: [{ key: 'TOKEN', value: 'synthetic' }]
    })
    const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 'bot-token' }) }
    const bot = { botId: 'isolated', folder: '/bots/isolated' }
    // Values not yet in the credential store never reach a CLI.
    await expect(
      BotLaunchTools.for(relay, { ...bot, agent: 'claude' }, [remote, command])
    ).rejects.toThrow('saved values')
    const stored = { name: 'docs', url: 'https://docs.example/mcp', credential: 'cred-docs-1' }
    const claude = await BotLaunchTools.for(relay, { ...bot, agent: 'claude' }, [stored, command])
    const codex = await BotLaunchTools.for(relay, { ...bot, agent: 'codex' }, [stored, command])
    expect(claudeLaunchServers(claude)).toEqual({
      docs: {
        type: 'http',
        url: 'http://127.0.0.1:4100/bot-tools/cred-docs-1/mcp',
        headers: { authorization: 'Bearer ${ORCA_BOT_TOOLS_TOKEN}' }
      },
      local: {
        type: 'stdio',
        command: 'node',
        args: ['two words', '', ' edge '],
        env: { TOKEN: 'synthetic' }
      }
    })
    expect(codexBotToolsThreadConfig(codex)).toMatchObject({
      'mcp_servers.docs.http_headers': { authorization: 'Bearer bot-token' },
      'mcp_servers.local.args': ['two words', '', ' edge '],
      'mcp_servers.local.env': { TOKEN: 'synthetic' }
    })
    expect(
      claudeMirrorChanges(
        {
          docs: {
            type: 'http',
            url: 'https://docs.example/mcp',
            headers: { Authorization: 'synthetic' }
          }
        },
        [{ name: 'docs', url: 'https://docs.example/mcp' }]
      )
    ).toHaveLength(1)
    expect(
      redactBotToolProblems(new Map([['docs', { kind: 'failed', detail: 'oops synthetic' }]]), [
        remote
      ])
    ).toEqual({ docs: { kind: 'failed', detail: 'oops [redacted]' } })
  })
})

describe('a tool Orca manages', () => {
  it('refuses a generic edit, which would drop the headers its source adds', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'bot-tool-details-'))
    dirs.push(folder)
    const cli: BotToolsCli = {
      botId: 'isolated',
      agent: 'codex',
      folder,
      signInFolder: join(folder, 'sign-in'),
      command: 'unused',
      prefixArgs: [],
      env: {},
      accountHome: folder,
      otherBotFolders: []
    }
    await changeBotToolServers(
      folder,
      () => [
        { name: 'hub', url: 'https://hub.example/mcp', transport: 'http', credential: 'cred-hub-1' }
      ],
      undefined,
      undefined,
      new Map([['cred-hub-1', { url: 'https://hub.example/mcp', headers: {}, source: 'hub' }]])
    )
    const details = await readBotToolDetails(folder, 'hub')
    await expect(
      updateBotTool(cli, 'hub', details.version, {
        name: 'renamed',
        url: 'https://hub.example/mcp',
        transport: 'http',
        headers: []
      })
    ).rejects.toThrow('Orca manages this tool')
    expect(readBotToolCredential(folder, 'cred-hub-1')?.source).toBe('hub')
  })
})
