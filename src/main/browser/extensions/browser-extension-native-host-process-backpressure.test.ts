import { once } from 'node:events'
import { endianness } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_HOST_ERRORS } from './browser-extension-native-host-errors'
import {
  killAllNativeHosts,
  startNativeHost,
  type NativeHostConnection
} from './browser-extension-native-host-process'

const owned: {
  child: PipedChildProcess
  connection: NativeHostConnection
  closed: Promise<unknown>
}[] = []
const BODY_LIMIT = 64 * 1024 * 1024

async function controlledHost(script = 'setInterval(() => {}, 1000);', bufferStdout = false) {
  const pending: (() => void)[] = []
  const frames: Buffer[] = []
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      frames.push(chunk)
      pending.push(callback)
    }
  })
  const write = vi.spyOn(stdin, 'write')
  const children: PipedChildProcess[] = []
  const closes: string[] = []
  const messages: string[] = []
  let closed: Promise<unknown> = Promise.resolve()
  const connection = await startNativeHost(
    { name: 'com.example.backpressure', program: process.execPath, args: [] },
    {
      onMessage: (json) => messages.push(json),
      onClose: (error) => closes.push(error)
    },
    (spec) => {
      const child = spawnProcess({
        ...spec,
        program: process.execPath,
        args: ['-e', `process.send({type:'ready'}); ${script}`],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      })
      child.stdin.destroy()
      child.stdin = stdin
      if (bufferStdout) {
        const stdout = new PassThrough()
        child.stdout.pipe(stdout)
        child.stdout = stdout
      }
      closed = once(child, 'close')
      children.push(child)
      return child
    }
  )
  const child = children[0]
  owned.push({ child, connection, closed })
  return {
    child,
    connection,
    stdin,
    write,
    frames,
    closes,
    messages,
    complete: () => {
      const callback = pending.shift()
      expect(callback).toBeTypeOf('function')
      callback?.()
    }
  }
}

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async ({ child, connection, closed }) => {
      connection.close()
      child.kill('SIGKILL')
      await closed
    })
  )
})

describe('native host outgoing backpressure', () => {
  it('disconnects a synchronous burst at the host entry bound and ignores later sends', async () => {
    const host = await controlledHost()
    for (let i = 0; i < 256; i++) {
      host.connection.send('0')
    }
    expect(host.stdin.writableLength).toBe(256 * 5)
    expect(host.frames).toHaveLength(1)
    host.connection.send('0')
    host.connection.send('0')
    expect(host.closes).toEqual([NATIVE_HOST_ERRORS.io])
    expect(host.stdin.destroyed).toBe(true)
    expect(host.write).toHaveBeenCalledTimes(256)
  })

  it('preserves native-endian UTF-8 FIFO frames and restores capacity on completion', async () => {
    const host = await controlledHost()
    const texts = ['"héllo 🦈"', '2']
    for (const text of texts) {
      host.connection.send(text)
    }
    expect(host.stdin.writableLength).toBe(
      texts.reduce((bytes, text) => bytes + 4 + Buffer.byteLength(text), 0)
    )
    host.complete()
    host.complete()
    await vi.waitFor(() => expect(host.stdin.writableLength).toBe(0))
    expect(host.frames.map((frame) => frame.subarray(4).toString('utf8'))).toEqual(texts)
    for (const frame of host.frames) {
      const bytes = endianness() === 'LE' ? frame.readUInt32LE(0) : frame.readUInt32BE(0)
      expect(bytes).toBe(frame.length - 4)
    }
    for (let i = 0; i < 256; i++) {
      host.connection.send('0')
    }
    expect(host.closes).toEqual([])
    expect(host.stdin.writableLength).toBe(256 * 5)
  })

  it('checks outgoing UTF-8 bytes before writing and permits the exact 64 MiB body', async () => {
    const json = `"${'é'.repeat((BODY_LIMIT - 2) / 2)}"`
    const oversized = await controlledHost()
    oversized.connection.send(`${json} `)
    expect(oversized.closes).toEqual([NATIVE_HOST_ERRORS.io])
    expect(oversized.write).not.toHaveBeenCalled()
    const exact = await controlledHost()
    exact.connection.send(json)
    expect(exact.closes).toEqual([])
    expect(exact.stdin.writableLength).toBe(BODY_LIMIT + 4)
    expect(exact.frames[0].subarray(4).equals(Buffer.from(json))).toBe(true)
    exact.connection.send('0')
    expect(exact.closes).toEqual([])
    exact.connection.send(json)
    expect(exact.closes).toEqual([NATIVE_HOST_ERRORS.io])
    expect(exact.write).toHaveBeenCalledTimes(2)
  })

  it('evicts the largest stalled host for a fresh one and releases each claim once', async () => {
    const hosts = await Promise.all(Array.from({ length: 4 }, () => controlledHost()))
    for (const host of hosts) {
      for (let i = 0; i < 256; i++) {
        host.connection.send('0')
      }
    }
    const fresh = await controlledHost()
    fresh.connection.send('0')
    expect(fresh.closes).toEqual([])
    expect(fresh.write).toHaveBeenCalledTimes(1)
    expect(hosts.map((host) => host.closes)).toEqual([[NATIVE_HOST_ERRORS.io], [], [], []])
    expect(hosts[0].stdin.destroyed).toBe(true)
    const successor = await controlledHost()
    for (let i = 0; i < 255; i++) {
      successor.connection.send('0')
    }
    hosts[0].complete()
    await new Promise<void>((resolve) => setImmediate(resolve))
    fresh.connection.send('0')
    expect(hosts.map((host) => host.closes.length)).toEqual([1, 1, 0, 0])
    hosts[2].stdin.destroy(new Error('write failed'))
    await vi.waitFor(() => expect(hosts[2].closes).toEqual([NATIVE_HOST_ERRORS.io]))
    for (let i = 0; i < 254; i++) {
      fresh.connection.send('0')
    }
    expect(hosts[3].closes).toEqual([])
    expect(fresh.closes).toEqual([])
  })

  it('stops writes on exit while delivering a final reply still buffered on stdout', async () => {
    const host = await controlledHost(
      `
      process.on('message', () => {
        const frame = Buffer.alloc(5);
        require('os').endianness() === 'LE' ? frame.writeUInt32LE(1) : frame.writeUInt32BE(1);
        frame.write('1', 4);
        process.stdout.end(frame, () => process.exit(0));
      });
    `,
      true
    )
    host.connection.send('0')
    host.child.stdout.pause()
    const exited = once(host.child, 'exit')
    host.child.send('exit')
    await exited
    host.connection.send('0')
    expect(host.write).toHaveBeenCalledTimes(1)
    expect(host.closes).toEqual([])
    host.complete()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(host.closes).toEqual([])
    host.child.stdout.resume()
    await vi.waitFor(() => expect(host.closes).toEqual([NATIVE_HOST_ERRORS.exited]))
    expect(host.messages).toEqual(['1'])
  })

  it('releases shutdown claims synchronously and does not admit another write to a killed host', async () => {
    const hosts = await Promise.all(Array.from({ length: 4 }, () => controlledHost()))
    for (const host of hosts) {
      for (let i = 0; i < 256; i++) {
        host.connection.send('0')
      }
    }
    killAllNativeHosts()
    for (const host of hosts) {
      host.connection.send('0')
      expect(host.write).toHaveBeenCalledTimes(256)
    }
    const successor = await controlledHost()
    for (let i = 0; i < 256; i++) {
      successor.connection.send('0')
    }
    expect(successor.closes).toEqual([])
  })
})
