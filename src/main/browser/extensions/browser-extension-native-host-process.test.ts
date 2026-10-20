import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  killAllNativeHosts,
  startNativeHost,
  type NativeHostConnection
} from './browser-extension-native-host-process'

vi.setConfig({ testTimeout: 20_000 })

// Hosts are Node scripts run with `node -e`; each frames output like a real native host.
const FRAMING = `
const le = require('os').endianness() === 'LE';
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  le ? head.writeUInt32LE(body.length) : head.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
};
const onMessages = (handle) => {
  let buffered = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = le ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
      if (buffered.length < 4 + size) return;
      const message = JSON.parse(buffered.subarray(4, 4 + size).toString());
      buffered = buffered.subarray(4 + size);
      handle(message);
    }
  });
};
if (process.env.PID_FILE) require('fs').writeFileSync(process.env.PID_FILE, String(process.pid));
`
const ECHO = `${FRAMING} onMessages((message) => send({ echo: message, argv: process.argv.slice(1) }));`
// A large last reply spans many reads; all of it must arrive before the exit is reported.
const REPLY_THEN_EXIT = `${FRAMING} send({ hello: 'x'.repeat(900 * 1024) }); process.stdout.end(() => process.exit(0));`
const IGNORES_EOF = `${FRAMING} process.stdin.resume(); setInterval(() => {}, 1000);`
const OVERSIZED = `${FRAMING} send('x'.repeat(1024 * 1024));`
const NOISY = `${FRAMING} process.stderr.write('e'.repeat(10000)); setInterval(() => {}, 1000);`

const root = mkdtempSync(join(tmpdir(), 'orca-native-host-'))
let pidFiles = 0

afterAll(() => {
  killAllNativeHosts()
  rmSync(root, { recursive: true, force: true })
})

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function start(script: string) {
  const messages: string[] = []
  const closes: string[] = []
  const pidFile = join(root, `pid-${pidFiles++}`)
  process.env.PID_FILE = pidFile
  const connection: NativeHostConnection = await startNativeHost(
    {
      name: 'com.example.test',
      program: process.execPath,
      args: ['-e', script, 'chrome-extension://abc/']
    },
    { onMessage: (json) => messages.push(json), onClose: (error) => closes.push(error) }
  )
  delete process.env.PID_FILE
  const pid = async () => {
    await expect.poll(() => readFileSync(pidFile, 'utf8').length > 0, { timeout: 5000 }).toBe(true)
    return Number(readFileSync(pidFile, 'utf8'))
  }
  return { connection, messages, closes, pid }
}

describe('native host process', () => {
  it('round-trips messages and passes the origin as the first argument', async () => {
    const host = await start(ECHO)
    host.connection.send(JSON.stringify({ text: 'héllo 🦈' }))
    host.connection.send('2')
    await expect.poll(() => host.messages.length).toBe(2)
    expect(JSON.parse(host.messages[0])).toEqual({
      echo: { text: 'héllo 🦈' },
      argv: ['chrome-extension://abc/']
    })
    expect(JSON.parse(host.messages[1]).echo).toBe(2)
    host.connection.close()
  })

  it('delivers the last reply, then reports the exit as Chrome does', async () => {
    const host = await start(REPLY_THEN_EXIT)
    await expect.poll(() => host.closes).toEqual(['Native host has exited.'])
    expect(host.messages.map((json) => JSON.parse(json).hello.length)).toEqual([900 * 1024])
  })

  it('rejects with Chrome’s start error when the host cannot run', async () => {
    await expect(
      startNativeHost(
        { name: 'missing', program: join(root, 'no-such-host'), args: [] },
        { onMessage: () => {}, onClose: () => {} }
      )
    ).rejects.toThrow('Failed to start native messaging host.')
  })

  it('kills a host that ignores its closed stdin once the grace period ends', async () => {
    const host = await start(IGNORES_EOF)
    const pid = await host.pid()
    host.connection.close()
    expect(isRunning(pid)).toBe(true)
    await expect.poll(() => isRunning(pid), { timeout: 8000 }).toBe(false)
    // Closing from Orca's side never reports back to the extension.
    expect(host.closes).toEqual([])
  })

  it('treats a message over 1 MB as a communication error and kills the host', async () => {
    const host = await start(OVERSIZED)
    await expect
      .poll(() => host.closes)
      .toEqual(['Error when communicating with the native messaging host.'])
    expect(host.messages).toEqual([])
  })

  it('forwards a bounded amount of stderr to Orca’s log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await start(NOISY)
    await expect.poll(() => warn.mock.calls.length).toBeGreaterThan(0)
    const logged = warn.mock.calls.map((call) => String(call[0])).join('')
    expect(logged).toContain('com.example.test')
    expect(logged.length).toBeLessThan(5000)
    const pid = await host.pid()
    killAllNativeHosts()
    await expect.poll(() => isRunning(pid)).toBe(false)
    warn.mockRestore()
  })
})
