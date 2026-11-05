import { once } from 'node:events'

import { PassThrough, Writable } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_HOST_ERRORS } from './browser-extension-native-host-errors'
import { startNativeHost, type NativeHostConnection } from './browser-extension-native-host-process'

const owned: {
  child: PipedChildProcess
  connection: NativeHostConnection
  closed: Promise<unknown>
}[] = []

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
})
