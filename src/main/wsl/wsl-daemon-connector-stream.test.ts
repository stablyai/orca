import { DaemonConnectionLostError } from '../daemon/daemon-errors'
import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { runProcess } from '../../shared/child-process/run-process'
import { openWslDaemonConnectorStream } from './wsl-daemon-connector-stream'
import {
  WSL_DAEMON_CONNECTOR_SCRIPT,
  WSL_DAEMON_READ_TOKEN_SCRIPT
} from './wsl-daemon-connector-script'

const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup())
)
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-guest-channel-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    socket: join(directory, 'd.sock'),
    home: process.env.HOME,
    userId: String(process.getuid?.())
  }
}
const unix = it.skipIf(process.platform === 'win32')

unix(
  'preserves raw bytes and the last reply through connector EOF without stopping the server',
  async () => {
    const plan = fixture()
    const reply = Buffer.alloc(256 * 1024)
    for (let index = 0; index < reply.length; index++) {
      reply[index] = index % 256
    }
    const server = createServer((socket) => {
      socket.once('data', () => socket.end(reply))
    })
    cleanups.push(() => server.close())
    server.listen(plan.socket)
    await once(server, 'listening')
    const stream = await openWslDaemonConnectorStream(
      {
        program: process.execPath,
        args: ['-e', WSL_DAEMON_CONNECTOR_SCRIPT, JSON.stringify(plan)]
      },
      AbortSignal.timeout(10_000)
    )
    expect(stream.readableObjectMode).toBe(false)
    expect(stream.writableObjectMode).toBe(false)
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    const ended = once(stream, 'end')
    stream.write('request')
    await ended
    expect(Buffer.concat(chunks).equals(reply)).toBe(true)
    expect(server.listening).toBe(true)
    stream.destroy()
  }
)

unix('rejects changed guest identity before connecting', async () => {
  const plan = { ...fixture(), userId: '-1' }
  await expect(
    openWslDaemonConnectorStream(
      {
        program: process.execPath,
        args: ['-e', WSL_DAEMON_CONNECTOR_SCRIPT, JSON.stringify(plan)]
      },
      AbortSignal.timeout(10_000)
    )
  ).rejects.toBeInstanceOf(DaemonConnectionLostError)
})

it('cancels a connector that never reaches readiness', async () => {
  const abort = new AbortController()
  const pending = openWslDaemonConnectorStream(
    {
      program: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)']
    },
    abort.signal
  )
  abort.abort()
  await expect(pending).rejects.toThrow('canceled')
})

unix('only reads an owner-private regular token, never a symlink', async () => {
  const plan = fixture()
  const tokenPath = join(plan.directory, 'token')
  writeFileSync(tokenPath, 'test-private-token', { mode: 0o600 })
  const read = (file: string) =>
    runProcess({
      program: process.execPath,
      args: ['-e', WSL_DAEMON_READ_TOKEN_SCRIPT, JSON.stringify({ ...plan, tokenPath: file })],
      timeoutMs: 10_000
    })
  const valid = await read(tokenPath)
  expect(valid.code).toBe(0)
  expect(valid.stdout).toBe('test-private-token')
  const alias = join(plan.directory, 'alias')
  symlinkSync(tokenPath, alias)
  const refused = await read(alias)
  expect(refused.code).not.toBe(0)
  expect(refused.stdout).toBe('')
})
