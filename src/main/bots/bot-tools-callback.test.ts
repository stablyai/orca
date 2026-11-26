import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  botToolSignInStatus,
  connectBotTool,
  finishBotToolSignIn,
  forgetBotToolSignIns
} from './bot-tools-sign-in'
import { writeBotToolServers, readBotToolServers } from './bot-tools-file'
import type { BotToolsCli } from './bot-tools-host'
import { removeBotTool } from './bot-tools-removal'
import { removeTree } from '../../shared/file-write/windows-transient-lock-removal'
import { useBotToolCredentialsRoot } from './bot-tool-credentials'

// Native sign-in polls every two seconds and tears down a CLI child.
it('keeps native Connect, callback paste-back and Remove for a tool that signs in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-tool-callback-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
  onTestFinished(() => useBotToolCredentialsRoot(null))
  const signedIn = join(root, 'signed-in')
  const callback = createServer(async (_request, response) => {
    await writeFile(signedIn, 'done')
    response.writeHead(200).end('Done')
  })
  await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve))
  const address = callback.address()
  if (!address || typeof address === 'string') {
    throw new Error('No callback listener')
  }
  const redirect = `http://127.0.0.1:${address.port}/callback`
  const authorizationUrl = `https://auth.example/authorize?redirect_uri=${encodeURIComponent(redirect)}`
  const script = `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id' in m))return;let result={};if(m.method==='thread/start'){if(m.params.config['mcp_servers.docs.url']!=='https://docs.example/mcp')process.exit(3);result={thread:{id:'test-thread'}}}if(m.method==='mcpServer/oauth/login')result={authorizationUrl:${JSON.stringify(authorizationUrl)}};if(m.method==='mcpServerStatus/list')result={data:[{name:'docs',runtimeStatus:fs.existsSync(${JSON.stringify(signedIn)})?'connected':'authenticationRequired'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`
  const cli: BotToolsCli = {
    botId: 'isolated-callback',
    agent: 'codex',
    folder: root,
    signInFolder: join(root, 'mirror'),
    command: process.execPath,
    prefixArgs: ['-e', script],
    env: {},
    accountHome: root,
    otherBotFolders: []
  }
  try {
    await writeBotToolServers(root, [{ name: 'docs', url: 'https://docs.example/mcp' }])
    expect(await connectBotTool(cli.botId, 'docs', async () => cli)).toEqual({ authorizationUrl })
    expect(botToolSignInStatus(cli.botId, 'docs')).toBe('pending')
    await expect(
      finishBotToolSignIn(cli, 'docs', 'https://other.example/callback?code=synthetic')
    ).rejects.toThrow("isn't the address")
    await finishBotToolSignIn(cli, 'docs', `${redirect}?code=synthetic`)
    // Why the native sign-in poll plus a loaded-host CLI spawn outlasts a 5s wait.
    await vi.waitFor(() => expect(botToolSignInStatus(cli.botId, 'docs')).toBe('done'), {
      timeout: 60_000
    })
    await removeBotTool(cli, 'docs')
    expect(await readBotToolServers(root)).toEqual([])
  } finally {
    forgetBotToolSignIns(cli.botId)
    callback.closeAllConnections()
    await new Promise<void>((resolve) => callback.close(() => resolve()))
    await removeTree(root)
  }
  // Why the 10s budget cannot cover loaded-host CLI spawns plus 2s poll cycles.
}, 120_000)
