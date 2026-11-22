import { createServer } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { botToolProblems, type BotToolsCli } from './bot-tools-host'
import { writeBotToolServers } from './bot-tools-file'
import { useBotToolCredentialsRoot } from './bot-tool-credentials'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const reply = (method: string, params: { protocolVersion?: string } | undefined) =>
  method === 'initialize'
    ? {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'isolated-tool', version: '1' }
      }
    : method === 'tools/list'
      ? {
          tools: [
            {
              name: 'isolated_ping',
              description: 'Local fixture',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        }
      : {}

describe.skipIf(process.env.RUN_BOT_TOOL_NATIVE_CLI !== '1')('actual native bot MCP config', () => {
  it.each(['claude', 'codex'] as const)(
    'checks HTTP headers and exact command argv/env/cwd through %s',
    async (agent) => {
      const root = await mkdtemp(join(tmpdir(), `bot-tool-native-${agent}-`))
      roots.push(root)
      const folder = join(root, 'bot-home')
      const accountHome = join(root, 'account')
      await Promise.all([mkdir(folder), mkdir(accountHome)])
      useBotToolCredentialsRoot(join(root, 'credentials'))
      const seen: string[] = []
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        seen.push(String(request.headers['x-fixture-secret'] ?? ''))
        let body = ''
        for await (const chunk of request) {
          body += chunk
        }
        const message = JSON.parse(body)
        if (!('id' in message)) {
          response.writeHead(202).end()
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: reply(message.method, message.params)
          })
        )
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No loopback listener')
      }
      const recording = join(root, 'command-received.json')
      const stdio = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(recording)},JSON.stringify({argv:process.argv.slice(1),env:process.env.FIXTURE_TOKEN,cwd:process.cwd()}));require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id' in m))return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated',version:'1'}}:m.method==='tools/list'?{tools:[{name:'isolated_ping',inputSchema:{type:'object'}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`
      const cli: BotToolsCli = {
        botId: 'isolated',
        agent,
        folder,
        signInFolder: join(root, 'sign-in'),
        command:
          process.env[agent === 'claude' ? 'BOT_TOOL_CLAUDE_CLI' : 'BOT_TOOL_CODEX_CLI'] ?? agent,
        prefixArgs: [],
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          CLAUDE_CONFIG_DIR: accountHome,
          CODEX_HOME: accountHome
        },
        accountHome,
        otherBotFolders: []
      }
      try {
        await writeBotToolServers(folder, [
          {
            name: 'httpfixture',
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: { 'X-Fixture-Secret': 'synthetic-header' }
          },
          {
            name: 'commandfixture',
            command: process.execPath,
            args: ['-e', stdio, '--', 'two words', '', ' edge '],
            env: { FIXTURE_TOKEN: 'synthetic-env' }
          },
          { name: 'brokenfixture', command: join(root, 'not-an-executable'), args: [] }
        ])
        const problems = await botToolProblems(cli)
        expect(Object.keys(problems)).toEqual(['brokenfixture'])
        expect(problems.brokenfixture?.kind).toBe('failed')
        expect(seen.length).toBeGreaterThan(0)
        // The header reached the server through Orca's relay; the CLI's own home never saw it.
        expect(seen.every((value) => value === 'synthetic-header')).toBe(true)
        expect(await filesContaining(accountHome, 'synthetic-header')).toEqual([])
        expect(await readFile(join(folder, '.orca', 'bot-tools.json'), 'utf8')).not.toContain(
          'synthetic-header'
        )
        expect(JSON.parse(await readFile(recording, 'utf8'))).toEqual({
          argv: ['two words', '', ' edge '],
          env: 'synthetic-env',
          cwd: await realpath(folder)
        })
      } finally {
        useBotToolCredentialsRoot(null)
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    120_000
  )
})

async function filesContaining(dir: string, text: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      if ((await readFile(path)).includes(text)) {
        found.push(path)
      }
    }
  }
  return found
}
