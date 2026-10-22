import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { initializeMspClient, MspClient, mintMspCommandId, spawnMspClient } from './msp-client'

// A canned MSP host: answers initialize and session/start, then emits one agent
// delta and completes the turn it is given.
const STUB_SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stub' } } }) + '\\n');
    } else if (msg.method === 'session/start') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { session: { sessionId: 'sess-1', status: 'idle' } } }) + '\\n');
    } else if (msg.method === 'turn/start') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-9', status: 'accepted' } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/delta', params: { sessionId: 'sess-1', itemId: 'item-1', field: 'text', delta: 'hi' } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 'sess-1', turnId: 'turn-9' } }) + '\\n');
    } else if (msg.method === 'approval/decide') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');
    }
  }
});
`

function stubSpawn(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', STUB_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('mintMspCommandId', () => {
  it('mints UUIDv7 ids', () => {
    const first = mintMspCommandId()
    const second = mintMspCommandId()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first).not.toBe(second)
  })
})

describe('MspClient', () => {
  it('handshakes, starts a session, and streams turn events', async () => {
    const seen: { method: string; params: unknown }[] = []
    const client = new MspClient(
      stubSpawn(),
      async () => null,
      (method, params) => {
        seen.push({ method, params })
      }
    )
    try {
      const hello = await initializeMspClient(client, { name: 'test', version: '0' })
      expect(hello.serverInfo?.name).toBe('stub')
      const started = await client.request<{ session: { sessionId: string } }>('session/start', {
        commandId: mintMspCommandId(),
        workspaceRoot: '/tmp'
      })
      expect(started.session.sessionId).toBe('sess-1')
      const turn = await client.request<{ turnId: string }>('turn/start', {
        commandId: mintMspCommandId(),
        sessionId: 'sess-1',
        input: [{ type: 'text', text: 'hi' }]
      })
      expect(turn.turnId).toBe('turn-9')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(seen.map((entry) => entry.method)).toEqual(['item/delta', 'turn/completed'])
      const decided = await client.request('approval/decide', {
        commandId: mintMspCommandId(),
        sessionId: 'sess-1',
        approvalId: 'a',
        requirementId: 'r',
        choiceId: 'c'
      })
      expect(decided).toEqual({ ok: true })
    } finally {
      await client.close('SIGKILL')
    }
  }, 15000)

  it('answers server-initiated requests', async () => {
    const server = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'ping') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'approval/request', params: { approvalId: 'a-1' } }) + '\\n');
    } else if (msg.id === 99) {
      process.stderr.write('saw-decide:' + JSON.stringify(msg.result) + '\\n');
      process.exit(0);
    }
  }
});
`
    const child = spawn(process.execPath, ['-e', server], { stdio: ['pipe', 'pipe', 'pipe'] })
    let decided: unknown = null
    const client = new MspClient(child, async (method, params) => {
      expect(method).toBe('approval/request')
      decided = params
      return { choiceId: 'yes', requirementId: 'r' }
    })
    try {
      await client.request('ping', {}).catch(() => undefined)
      for (let i = 0; i < 50 && decided === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(decided).toMatchObject({ approvalId: 'a-1' })
    } finally {
      await client.close('SIGKILL').catch(() => undefined)
    }
  }, 15000)

  it('fails pending requests when the child exits', async () => {
    const client = spawnMspClient({
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: '/tmp',
      env: process.env
    })
    await expect(client.request('session/start', {})).rejects.toThrow()
    await client.close('SIGKILL').catch(() => undefined)
  }, 15000)
})
