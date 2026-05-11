/**
 * End-to-end in-process integration test.
 *
 * Wires the client-side SshChannelMultiplexer directly to the relay-side
 * RelayDispatcher through an in-memory pipe — no SSH, no subprocess.
 * Validates the full JSON-RPC roundtrip: client request → framing →
 * relay decode → handler → response → framing → client decode → result.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm, readFile, stat } from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'

import { RelayDispatcher } from './dispatcher'
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

    it('writeFile creates/overwrites file content', async () => {
      const filePath = path.join(tmpDir, 'output.txt')

      await mux.request('fs.writeFile', { filePath, content: 'written via relay' })

      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('written via relay')
    })

    it('stat returns file metadata', async () => {
      writeFileSync(path.join(tmpDir, 'sized.txt'), 'abcdef')

      const result = (await mux.request('fs.stat', {
        filePath: path.join(tmpDir, 'sized.txt')
      })) as { size: number; type: string; mtime: number }

      expect(result.type).toBe('file')
      expect(result.size).toBe(6)
      expect(typeof result.mtime).toBe('number')
    })

    it('createFile + deletePath roundtrip', async () => {
      const filePath = path.join(tmpDir, 'nested', 'deep', 'new.txt')

      await mux.request('fs.createFile', { filePath })
      const s = await stat(filePath)
      expect(s.isFile()).toBe(true)

      await mux.request('fs.deletePath', { targetPath: filePath })
      await expect(stat(filePath)).rejects.toThrow()
    })

    it('createDir creates directories recursively', async () => {
      const dirPath = path.join(tmpDir, 'a', 'b', 'c')

      await mux.request('fs.createDir', { dirPath })
      const s = await stat(dirPath)
      expect(s.isDirectory()).toBe(true)
    })

    it('rename moves files', async () => {
      const oldPath = path.join(tmpDir, 'before.txt')
      const newPath = path.join(tmpDir, 'after.txt')
      writeFileSync(oldPath, 'moving')

      await mux.request('fs.rename', { oldPath, newPath })

      await expect(stat(oldPath)).rejects.toThrow()
      const content = await readFile(newPath, 'utf-8')
      expect(content).toBe('moving')
    })

    it('copy duplicates files', async () => {
      const src = path.join(tmpDir, 'src.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      writeFileSync(src, 'original')

      await mux.request('fs.copy', { source: src, destination: dst })

      const content = await readFile(dst, 'utf-8')
      expect(content).toBe('original')
    })

    it('readFile returns error for non-existent file', async () => {
      await expect(
        mux.request('fs.readFile', { filePath: path.join(tmpDir, 'nope.txt') })
      ).rejects.toThrow()
    })

    it('errors propagate correctly through the protocol', async () => {
      await expect(
        mux.request('fs.stat', { filePath: '/nonexistent/path/that/does/not/exist' })
      ).rejects.toThrow()
    })
  })

  // ─── Git ────────────────────────────────────────────────────────

  describe('Git operations', () => {
    beforeEach(() => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'initial')
      gitCommit(tmpDir, 'initial commit')
    })

    it('git.status returns clean status for committed repo', async () => {
      const result = (await mux.request('git.status', {
        worktreePath: tmpDir
      })) as { entries: unknown[]; conflictOperation: string }

      expect(result.entries).toEqual([])
      expect(result.conflictOperation).toBe('unknown')
    })

    it('git.status detects modifications', async () => {
      writeFileSync(path.join(tmpDir, 'file.txt'), 'modified')

      const result = (await mux.request('git.status', {
        worktreePath: tmpDir
      })) as { entries: { path: string; status: string; area: string }[] }

      const entry = result.entries.find((e) => e.path === 'file.txt')
      expect(entry).toBeDefined()
      expect(entry!.status).toBe('modified')
      expect(entry!.area).toBe('unstaged')
    })

    it('git.status detects untracked files', async () => {
      writeFileSync(path.join(tmpDir, 'new.txt'), 'new')

      const result = (await mux.request('git.status', {
        worktreePath: tmpDir
      })) as { entries: { path: string; status: string; area: string }[] }

      const entry = result.entries.find((e) => e.path === 'new.txt')
      expect(entry).toBeDefined()
      expect(entry!.status).toBe('untracked')
    })

    it('git.stage + git.status shows staged entry', async () => {
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')

      await mux.request('git.stage', { worktreePath: tmpDir, filePath: 'file.txt' })

      const result = (await mux.request('git.status', {
        worktreePath: tmpDir
      })) as { entries: { path: string; area: string }[] }

      const staged = result.entries.find((e) => e.area === 'staged')
      expect(staged).toBeDefined()
    })

    it('git.unstage reverses staging', async () => {
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      await mux.request('git.stage', { worktreePath: tmpDir, filePath: 'file.txt' })
      await mux.request('git.unstage', { worktreePath: tmpDir, filePath: 'file.txt' })

      const result = (await mux.request('git.status', {
        worktreePath: tmpDir
      })) as { entries: { area: string }[] }

      const staged = result.entries.filter((e) => e.area === 'staged')
      expect(staged.length).toBe(0)
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

    it('git.diff returns staged diff', async () => {
      writeFileSync(path.join(tmpDir, 'file.txt'), 'staged version')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await mux.request('git.diff', {
        worktreePath: tmpDir,
        filePath: 'file.txt',
        staged: true
      })) as { originalContent: string; modifiedContent: string }

      expect(result.originalContent).toBe('initial')
      expect(result.modifiedContent).toBe('staged version')
    })

    it('git.discard restores tracked file to HEAD', async () => {
      writeFileSync(path.join(tmpDir, 'file.txt'), 'dirty')

      await mux.request('git.discard', { worktreePath: tmpDir, filePath: 'file.txt' })

      const content = await readFile(path.join(tmpDir, 'file.txt'), 'utf-8')
      expect(content).toBe('initial')
    })

    it('git.discard removes untracked file', async () => {
      writeFileSync(path.join(tmpDir, 'temp.txt'), 'throwaway')

      await mux.request('git.discard', { worktreePath: tmpDir, filePath: 'temp.txt' })

      await expect(stat(path.join(tmpDir, 'temp.txt'))).rejects.toThrow()
    })

    it('git.conflictOperation returns unknown for normal repo', async () => {
      const result = await mux.request('git.conflictOperation', {
        worktreePath: tmpDir
      })
      expect(result).toBe('unknown')
    })

    it('git.listWorktrees returns the main worktree', async () => {
      const result = (await mux.request('git.listWorktrees', {
        repoPath: tmpDir
      })) as { path: string; isMainWorktree: boolean }[]

      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0].isMainWorktree).toBe(true)
    })

    it('git.branchCompare works across branches', async () => {
      // Get current branch name (might be "main" or "master" depending on config)
      const defaultBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature work')
      gitCommit(tmpDir, 'feature commit')

      const result = (await mux.request('git.branchCompare', {
        worktreePath: tmpDir,
        baseRef: defaultBranch
      })) as { summary: { status: string; commitsAhead: number }; entries: unknown[] }

      expect(result.summary.status).toBe('ready')
      expect(result.summary.commitsAhead).toBe(1)
      expect(result.entries.length).toBe(1)
    })

    it('git.bulkStage stages multiple files at once', async () => {
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b')

      await mux.request('git.bulkStage', {
        worktreePath: tmpDir,
        filePaths: ['a.txt', 'b.txt']
      })

      const result = (await mux.request('git.status', {
        worktreePath: tmpDir
      })) as { entries: { path: string; area: string }[] }

      const staged = result.entries.filter((e) => e.area === 'staged')
      expect(staged.length).toBe(2)
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
