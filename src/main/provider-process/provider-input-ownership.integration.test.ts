import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { runProcess, spawnProcess } from '@orca/process-host'
import { expect, it, vi, type MockInstance } from 'vitest'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { sameProviderProcess, type ProviderGroupIdentity } from './provider-group-orphan-guard'
import * as processRows from './provider-process-row-read'
import type { ProviderProcessRow } from './provider-process-row-read'
import * as descendants from '../pty/process-retirement/pty-descendant-termination'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))

function cliFixture(socketPath: string): string {
  return String.raw`
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const side = require('node:net').connect(${JSON.stringify(socketPath)})
    const stdin = process.stdin
    stdin._handle.setBlocking(false)
    let tool
    const reply = (message) => side.write(JSON.stringify(message) + '\n')
    const exit = (event, code) => side.end(JSON.stringify({ event }) + '\n', () => process.exit(code))
    process.on('SIGTERM', () => exit('sigterm', 24))
    // Keep EOF observable until the controller explicitly arms the EOF-sensitive exit.
    require('node:readline').createInterface({ input: side }).on('line', (command) => {
      if (command === 'tool') {
        tool = spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 60000)"
        ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
        tool.stdout.once('data', () => reply({ event: 'tool', pid: tool.pid }))
      } else if (command === 'probe') {
        try {
          const count = fs.readSync(0, Buffer.alloc(1), 0, 1, null)
          reply({ event: 'probe', stdin: count === 0 ? 'eof' : 'data' })
        } catch (error) {
          if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error
          reply({ event: 'probe', stdin: 'open' })
        }
      } else if (command === 'arm') {
        stdin.once('end', () => exit('stdin-end', 23))
        reply({ event: 'armed' })
        stdin.resume()
      } else if (command === 'cleanup') {
        if (tool) tool.kill('SIGKILL')
        exit('cleanup', 0)
      } else {
        throw new Error('Unknown fixture command')
      }
    })
    side.on('connect', () => reply({ event: 'ready', pid: process.pid, parent: process.ppid }))
    side.on('close', () => {
      if (tool) tool.kill('SIGKILL')
      process.exit(0)
    })
  `
}

async function notRunning(pid: number): Promise<void> {
  const status = await runProcess({
    program: 'ps',
    args: ['-o', 'stat=', '-p', String(pid)],
    timeoutMs: 2_000
  })
  expect(status.timedOut).toBe(false)
  expect(status.code === 0 || status.code === 1).toBe(true)
  // Orphaned zombies can remain under a non-reaping init after H dies.
  expect(status.stdout.trim(), `pid ${pid}`).toMatch(/^(Z\S*)?$/)
}

async function beforeDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Missing fixture acknowledgement: ${label}`)),
          10_000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

it.runIf(process.platform !== 'win32').each(['owner loss', 'public EOF', 'SIGTERM', 'SIGUSR2'])(
  'holds %s across real H exit until fault capture can reap its detached tool',
  async (request) => {
    state.root = await mkdtemp(join(tmpdir(), 'orca-provider-input-'))
    const directory = join(state.root, 'provider-processes')
    const readRow = processRows.readPosixProcessRow
    const identities: ProviderProcessRow[] = []
    const remember = async (pid: number): Promise<ProviderProcessRow> => {
      const identity = await readRow(
        pid,
        process.platform === 'darwin' ? 'microsecond' : 'clock-tick'
      )
      if (!identity || identity === 'unverifiable' || identity.startResolution === 'second') {
        throw new Error(`Missing exact fixture identity for ${pid}`)
      }
      identities.push(identity)
      return identity
    }
    const connected = Promise.withResolvers<{
      socket: Socket
      next: () => Promise<Record<string, unknown>>
    }>()
    const cleanupAcknowledged = Promise.withResolvers<void>()
    let socket: Socket | undefined
    const server = createServer((client) => {
      socket = client
      const replies = createInterface({ input: client })
      replies.on('line', (line) => {
        if (JSON.parse(line).event === 'cleanup') {
          cleanupAcknowledged.resolve()
        }
      })
      const lines = replies[Symbol.asyncIterator]()
      connected.resolve({
        socket: client,
        next: async () => {
          const line = await beforeDeadline(lines.next(), 'side channel reply')
          if (line.done) {
            throw new Error('Fixture side channel closed before acknowledgement')
          }
          return JSON.parse(line.value)
        }
      })
      client.on('error', () => {})
    })
    server.on('error', (error) => connected.reject(error))
    const releaseRead = Promise.withResolvers<void>()
    let rowSpy: MockInstance<typeof processRows.readPosixProcessRow> | undefined
    let signalSpy: MockInstance<typeof descendants.sendDescendantSignal> | undefined
    let controlSpy: { mockRestore: () => void } | undefined
    let managed: ReturnType<typeof spawnManagedProviderProcess> | undefined
    let closed: Promise<unknown> | undefined
    let parent: ChildProcess | undefined
    const parentExited = Promise.withResolvers<[number | null, NodeJS.Signals | null]>()
    const parentInputClosed = Promise.withResolvers<void>()
    try {
      const socketPath = join(state.root, 's')
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      managed = spawnManagedProviderProcess(
        { command: process.execPath, cwd: state.root, args: ['-e', cliFixture(socketPath)] },
        {
          site: 'native-input-ownership-test',
          inheritedEnv: process.env,
          spawnImpl: (spec) => {
            parent = spawnProcess(spec)
            parent.once('exit', (code, signal) => parentExited.resolve([code, signal]))
            if (parent.stdin) {
              parent.stdin.once('close', () => parentInputClosed.resolve())
            } else {
              parentInputClosed.resolve()
            }
            return parent
          }
        }
      )
      const errors: Error[] = []
      managed.child.on('error', (error) => errors.push(error))
      managed.child.stdout.resume()
      closed = new Promise<unknown[]>((resolve) =>
        managed!.child.once('close', (...args) => resolve(args))
      )
      await managed.child.ready
      const side = await beforeDeadline(connected.promise, 'CLI connection')
      const hello = await side.next()
      expect(hello).toEqual({ event: 'ready', pid: managed.child.pid, parent: parent?.pid })
      if (!parent?.pid || !managed.child.pid) {
        throw new Error('Missing native H/P fixture')
      }
      const parentIdentity = await remember(parent.pid)
      const [recordName] = await readdir(directory)
      const record: ProviderGroupIdentity = JSON.parse(
        await readFile(join(directory, recordName), 'utf8')
      )
      const leader = await remember(managed.child.pid)
      const watcher = await remember(record.watcher.pid)
      expect(await readRow(leader.pid, record.leader.startResolution)).toEqual(record.leader)
      expect(await readRow(watcher.pid, record.watcher.startResolution)).toEqual(record.watcher)
      expect(leader.ppid).toBe(parentIdentity.pid)
      expect(watcher.ppid).toBe(leader.pid)

      side.socket.write('tool\n')
      const toolReply = await side.next()
      expect(toolReply.event).toBe('tool')
      if (typeof toolReply.pid !== 'number') {
        throw new Error('Missing detached tool PID')
      }
      const tool = await remember(toolReply.pid)
      expect(tool.ppid).toBe(leader.pid)
      expect(tool.pgid).toBe(tool.pid)
      expect(tool.pgid).not.toBe(leader.pgid)
      expect(tool.pgid).not.toBe(watcher.pgid)
      side.socket.write('probe\n')
      expect(await side.next()).toEqual({ event: 'probe', stdin: 'open' })

      // Installed after published ownership and CLI/tool acknowledgements, before killing real H.
      const readEntered = Promise.withResolvers<void>()
      let held = false
      rowSpy = vi.spyOn(processRows, 'readPosixProcessRow').mockImplementation(async (...args) => {
        if (!held && args[0] === leader.pid) {
          held = true
          readEntered.resolve()
          await releaseRead.promise
        }
        return readRow(...args)
      })
      signalSpy = vi.spyOn(descendants, 'sendDescendantSignal')
      expect(parent.kill('SIGKILL')).toBe(true)
      expect(await beforeDeadline(parentExited.promise, 'real H exit')).toEqual([null, 'SIGKILL'])
      await beforeDeadline(parentInputClosed.promise, 'H-owned stream zero close')
      await beforeDeadline(readEntered.promise, 'first fault identity read')

      // EAGAIN is the kernel's open-writer proof; do not infer it from a quiet JS stream.
      side.socket.write('probe\n')
      expect(await side.next()).toEqual({ event: 'probe', stdin: 'open' })
      expect(managed.child.stdin.destroyed).toBe(false)
      expect(managed.exitStatus).toBeNull()
      expect(await readdir(directory)).toEqual([recordName])
      side.socket.write('arm\n')
      expect(await side.next()).toEqual({ event: 'armed' })
      const destination = parent.stdio.at(7)
      const control = parent.stdio.at(3)
      if (!(destination instanceof Writable) || !(control instanceof Writable)) {
        throw new Error('Missing native input or stop channel')
      }
      const writes = vi.spyOn(control, 'write')
      controlSpy = writes
      if (request === 'public EOF') {
        const ended = once(managed.child.stdin, 'end')
        managed.child.stdin.end()
        await ended
      } else if (request === 'SIGTERM' || request === 'SIGUSR2') {
        managed.child.kill(request)
      }
      expect(destination.writableEnded).toBe(false)
      expect(writes.mock.calls).toEqual([])
      side.socket.write('probe\n')
      expect(await side.next()).toEqual({ event: 'probe', stdin: 'open' })
      releaseRead.resolve()

      if (request === 'owner loss' || request === 'public EOF') {
        expect(await side.next()).toEqual({ event: 'stdin-end' })
      }
      expect(await beforeDeadline(closed, 'provider close')).toEqual([null, null])
      expect(signalSpy.mock.calls.filter(([pid]) => pid === tool.pid)).toEqual([
        [tool.pid, 'SIGTERM'],
        [tool.pid, 'SIGKILL']
      ])
      expect(errors).toEqual([])
      expect(managed.exitStatus).toEqual({
        code: null,
        signal: null,
        processless: false,
        outcomeLost: true
      })
      expect(managed.rootExitObserved).toBe(false)
      expect(managed.rootVerdict).toBe('exited')
      expect(managed.child.groupVerdict).toBe('exited')
      await notRunning(leader.pid)
      await notRunning(watcher.pid)
      await notRunning(tool.pid)
      expect(await readdir(directory)).toEqual([])
    } finally {
      releaseRead.resolve()
      rowSpy?.mockRestore()
      signalSpy?.mockRestore()
      controlSpy?.mockRestore()
      try {
        // The fixture owns any tool created before its PID acknowledgement reached the test.
        if (socket && !socket.destroyed && !socket.writableEnded) {
          socket.write('cleanup\n')
          // Always attempt the identity-checked fallback even if the fixture cannot acknowledge.
          await beforeDeadline(cleanupAcknowledged.promise, 'fixture tool cleanup').catch(() => {})
        }
        const kills = await Promise.allSettled(
          identities.toReversed().map(async (expected) => {
            const current = await readRow(expected.pid, expected.startResolution)
            if (current && current !== 'unverifiable' && sameProviderProcess(expected, current)) {
              try {
                process.kill(expected.pid, 'SIGKILL')
              } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
                  throw error
                }
              }
            }
          })
        )
        managed?.child.kill('SIGKILL')
        parent?.kill('SIGKILL')
        if (closed) {
          await beforeDeadline(closed, 'fixture cleanup')
        }
        expect(kills.filter((result) => result.status === 'rejected')).toEqual([])
      } finally {
        socket?.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(state.root, { recursive: true, force: true })
      }
    }
  }
)
