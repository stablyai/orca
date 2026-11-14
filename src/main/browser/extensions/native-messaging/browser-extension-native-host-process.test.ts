import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { build } from 'esbuild'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  killAllNativeHosts,
  startNativeHost,
  type NativeHostConnection
} from './browser-extension-native-host-process'

vi.mock('../../../worker-threads/forked-child-entry-path', () => ({
  getForkedChildEntryPath: (fileName: string) => join(root, fileName)
}))

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

// A large last reply spans many reads; all of it must arrive before the exit is reported.
const REPLY_THEN_EXIT = `${FRAMING} send({ hello: 'x'.repeat(900 * 1024) }); process.stdout.end(() => process.exit(0));`
const IGNORES_EOF = `${FRAMING} process.stdin.resume(); setInterval(() => {}, 1000);`

const root = mkdtempSync(join(tmpdir(), 'orca-native-host-'))
let pidFiles = 0

beforeAll(async () => {
  if (process.platform === 'win32') {
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'junction')
    await build({
      entryPoints: [
        join(
          process.cwd(),
          'src/main/browser/extensions/native-messaging/browser-extension-native-host-supervisor-entry.ts'
        )
      ],
      outfile: join(root, 'browser-extension-native-host-supervisor-entry.js'),
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      nodePaths: [join(process.cwd(), 'node_modules')]
    })
  }
})

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
  it('delivers the last reply, then reports the exit as Chrome does', async () => {
    const host = await start(REPLY_THEN_EXIT)
    await expect.poll(() => host.closes).toEqual(['Native host has exited.'])
    expect(host.messages.map((json) => JSON.parse(json).hello.length)).toEqual([900 * 1024])
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

  it('kills helpers when their host exits after the channel closes', async () => {
    const host = await start(`${FRAMING}
      const helper = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      send({ helperPid: helper.pid });
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `)
    await expect.poll(() => host.messages.length).toBe(1)
    const helperPid = JSON.parse(host.messages[0]).helperPid
    const rootPid = await host.pid()
    try {
      host.connection.close()
      await expect.poll(() => isRunning(rootPid)).toBe(false)
      await expect.poll(() => isRunning(helperPid), { timeout: 8000 }).toBe(false)
    } finally {
      try {
        process.kill(helperPid, 'SIGKILL')
      } catch {}
    }
  })

  it('waits for the Windows supervisor to start the host before exposing its connection', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const children: ChildProcessWithoutNullStreams[] = []
    const messages: string[] = []
    let resolved = false
    try {
      const connectionPromise = startNativeHost(
        { name: 'supervised', program: process.execPath, args: [] },
        { onMessage: (json) => messages.push(json), onClose: () => {} },
        (spec) => {
          const child = spawnProcess({
            ...spec,
            program: process.execPath,
            args: [
              '-e',
              `process.stdin.pipe(process.stdout); process.on('message', (type) => process.send({ type }));`
            ],
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
          })
          children.push(child)
          return child
        }
      ).then((connection) => {
        resolved = true
        return connection
      })
      const [child] = children
      await once(child, 'spawn')
      const ping = once(child, 'message')
      child.send('ping')
      await ping
      expect(resolved).toBe(false)
      child.send('ready')
      const connection = await connectionPromise
      connection.send(JSON.stringify({ ready: true }))
      await expect.poll(() => messages).toEqual(['{"ready":true}'])
      connection.close()
    } finally {
      for (const child of children) {
        child.kill('SIGKILL')
      }
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
