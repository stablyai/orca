/**
 * End-to-end in-process integration test.
 *
 * Wires the client-side SshChannelMultiplexer directly to the relay-side
 * RelayDispatcher through an in-memory pipe — no SSH, no subprocess.
 * Validates the full JSON-RPC roundtrip: client request → framing →
 * relay decode → handler → response → framing → client decode → result.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'

import { RelayDispatcher } from '../wsl-guest/dispatcher'
import { RelayContext } from './context'
import { FsHandler } from './fs-handler'
import { GitHandler } from './git-handler'

function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' })
}

function gitCommit(dir: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' })
}

describe('Integration: Client Mux ↔ Relay Dispatcher', () => {
  let tmpDir: string
  let mux: SshChannelMultiplexer
  let dispatcher: RelayDispatcher
  let fsHandler: FsHandler
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-e2e-'))

    // Build the in-memory pipe
    let relayFeedFn: (data: Buffer) => void

    const clientDataCallbacks: ((data: Buffer) => void)[] = []
    const clientCloseCallbacks: (() => void)[] = []

    const clientTransport: MultiplexerTransport = {
      write: (data: Buffer) => {
        // Client → Relay
        setImmediate(() => relayFeedFn?.(data))
      },
      onData: (cb) => {
        clientDataCallbacks.push(cb)
      },
      onClose: (cb) => {
        clientCloseCallbacks.push(cb)
      }
    }

    // Relay side
    dispatcher = new RelayDispatcher((data: Buffer) => {
      // Relay → Client
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
      })
    })

    relayFeedFn = (data: Buffer) => dispatcher.feed(data)

    // Register handlers on the relay
    const context = new RelayContext()
    fsHandler = new FsHandler(dispatcher, context)
    new GitHandler(dispatcher, context)

    // Create client mux
    mux = new SshChannelMultiplexer(clientTransport)
  })

  afterEach(async () => {
    mux.dispose()
    dispatcher.dispose()
    fsHandler.dispose()
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ─── Filesystem ─────────────────────────────────────────────────

  describe('Filesystem operations', () => {
    it('readDir returns directory entries', async () => {
      writeFileSync(path.join(tmpDir, 'hello.txt'), 'world')
      writeFileSync(path.join(tmpDir, 'readme.md'), '# Hi')

      const result = (await mux.request('fs.readDir', { dirPath: tmpDir })) as {
        name: string
        isDirectory: boolean
        isSymlink: boolean
      }[]

      expect(result.length).toBe(2)
      const names = result.map((e) => e.name).sort()
      expect(names).toEqual(['hello.txt', 'readme.md'])
    })

    it('readFile returns text content', async () => {
      writeFileSync(path.join(tmpDir, 'data.txt'), 'some content')

      const result = (await mux.request('fs.readFile', {
        filePath: path.join(tmpDir, 'data.txt')
      })) as { content: string; isBinary: boolean }

      expect(result.content).toBe('some content')
      expect(result.isBinary).toBe(false)
    })

    // Why this one stays: writeRelayFile resolves to undefined, so the response frame
    // carries neither `result` nor `error` — the one payload shape the other cases here
    // do not produce, and one a mock dispatcher never has to settle. The client sees
    // `null`, not `undefined`: the member is absent from the frame, not carried as void.
    it('writeFile creates/overwrites file content', async () => {
      const filePath = path.join(tmpDir, 'output.txt')

      await expect(
        mux.request('fs.writeFile', { filePath, content: 'written via relay' })
      ).resolves.toBeNull()

      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('written via relay')
    })

    it('readFileStream round-trip preserves a 12 MB binary file', async () => {
      const filePath = path.join(tmpDir, 'big.png')
      const original = randomBytes(12 * 1024 * 1024)
      writeFileSync(filePath, original)
      const { readFileViaStream } = await import('../main/ssh/ssh-filesystem-stream-reader')
      const { content } = await readFileViaStream(mux, filePath)
      expect(Buffer.from(content, 'base64').equals(original)).toBe(true)
    }, 30_000)
  })

  // ─── Git ────────────────────────────────────────────────────────

  describe('Git operations', () => {
    beforeEach(() => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'initial')
      gitCommit(tmpDir, 'initial commit')
    })

    it('git.diff returns original and modified content', async () => {
      writeFileSync(path.join(tmpDir, 'file.txt'), 'updated content')

      const result = (await mux.request('git.diff', {
        worktreePath: tmpDir,
        filePath: 'file.txt',
        staged: false
      })) as { kind: string; originalContent: string; modifiedContent: string }

      expect(result.kind).toBe('text')
      expect(result.originalContent).toBe('initial')
      expect(result.modifiedContent).toBe('updated content')
    })
  })

  // ─── Error propagation ──────────────────────────────────────────

  describe('Error propagation', () => {
    it('method-not-found error for unknown methods', async () => {
      await expect(mux.request('nonexistent.method', {})).rejects.toThrow('Method not found')
    })

    it('handler errors propagate as JSON-RPC errors', async () => {
      await expect(
        mux.request('fs.readFile', { filePath: '/does/not/exist/at/all' })
      ).rejects.toThrow()
    })
  })

  // ─── Notifications ──────────────────────────────────────────────

  describe('Notifications', () => {
    it('relay notifications reach the client mux', async () => {
      const received: { method: string; params: Record<string, unknown> }[] = []
      mux.onNotification((method, params) => {
        received.push({ method, params })
      })

      // Trigger a fs operation that causes the relay to send notifications
      // (e.g., write a file — no notification expected for this, so we
      // test notification plumbing directly via the relay dispatcher)
      dispatcher.notify('custom.event', { key: 'value' })

      // Wait for the async delivery through setImmediate
      await new Promise((r) => setTimeout(r, 50))

      expect(received.length).toBe(1)
      expect(received[0].method).toBe('custom.event')
      expect(received[0].params).toEqual({ key: 'value' })
    })
  })
})
