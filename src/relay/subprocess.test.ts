import { afterAll, beforeAll, describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { build } from 'esbuild'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'

const RELAY_TS_ENTRY = path.resolve(__dirname, 'relay.ts')
let bundleDir: string
let relayEntry: string

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'relay-bundle-'))
  relayEntry = path.join(bundleDir, 'relay.js')
  await build({
    entryPoints: [RELAY_TS_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: relayEntry,
    external: ['node-pty', '@parcel/watcher'],
    sourcemap: false
  })
}, 30_000)

afterAll(async () => {
  if (bundleDir) {
    await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
  }
})

function spawn(args: string[] = []): RelayProcess {
  return spawnRelay(relayEntry, args)
}

describe('Subprocess: Relay entry point', () => {
  let relay: RelayProcess | null = null
  let tmpDir: string

  afterEach(async () => {
    if (relay && relay.proc.exitCode === null) {
      relay.proc.kill('SIGKILL')
      await relay.waitForExit().catch(() => {})
    }
    relay = null
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('prints sentinel on startup', async () => {
    relay = spawn()
    await relay.sentinelReceived
  }, 10_000)

  it('responds to fs.stat over stdin/stdout', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')

    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.stat', { filePath: path.join(tmpDir, 'test.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.result).toBeDefined()
    const result = resp.result as { size: number; type: string }
    expect(result.type).toBe('file')
    expect(result.size).toBe(5)
  }, 10_000)

  it('responds to fs.readDir', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
    writeFileSync(path.join(tmpDir, 'b.txt'), 'b')

    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.readDir', { dirPath: tmpDir })
    const resp = await relay.waitForResponse(id)

    const entries = resp.result as { name: string }[]
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'b.txt'])
  }, 10_000)

  it('responds to fs.readFile and fs.writeFile', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))

    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const filePath = path.join(tmpDir, 'output.txt')
    const wId = relay.send('fs.writeFile', { filePath, content: 'via subprocess' })
    const wResp = await relay.waitForResponse(wId)
    expect(wResp.error).toBeUndefined()

    const rId = relay.send('fs.readFile', { filePath })
    const rResp = await relay.waitForResponse(rId)
    const result = rResp.result as { content: string; isBinary: boolean }
    expect(result.content).toBe('via subprocess')
    expect(result.isBinary).toBe(false)
  }, 10_000)

  it('responds to git.status on a real repo', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' })
    writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' })
    writeFileSync(path.join(tmpDir, 'file.txt'), 'dirty')

    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('git.status', { worktreePath: tmpDir })
    const resp = await relay.waitForResponse(id)

    const result = resp.result as { entries: { path: string; status: string }[] }
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries[0].path).toBe('file.txt')
    expect(result.entries[0].status).toBe('modified')
  }, 10_000)

  it('returns JSON-RPC error for unknown method', async () => {
    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('does.not.exist', {})
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
    expect(resp.error!.code).toBe(-32601)
    expect(resp.error!.message).toContain('Method not found')
  }, 10_000)

  it('returns error for failing handler', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.readFile', { filePath: path.join(tmpDir, 'nonexistent.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
  }, 10_000)

  it('handles multiple concurrent requests', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'one.txt'), '1')
    writeFileSync(path.join(tmpDir, 'two.txt'), '22')
    writeFileSync(path.join(tmpDir, 'three.txt'), '333')

    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id1 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'one.txt') })
    const id2 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'two.txt') })
    const id3 = relay.send('fs.stat', { filePath: path.join(tmpDir, 'three.txt') })

    const [r1, r2, r3] = await Promise.all([
      relay.waitForResponse(id1),
      relay.waitForResponse(id2),
      relay.waitForResponse(id3)
    ])

    expect((r1.result as { size: number }).size).toBe(1)
    expect((r2.result as { size: number }).size).toBe(2)
    expect((r3.result as { size: number }).size).toBe(3)
  }, 10_000)

  it('shuts down cleanly on SIGTERM', async () => {
    relay = spawn()
    await relay.sentinelReceived

    relay.kill('SIGTERM')
    await relay.waitForExit()
    expect(relay.proc.exitCode !== null || relay.proc.signalCode !== null).toBe(true)
  }, 10_000)

  it('exits after grace period on stdin close when no PTYs exist', async () => {
    // Why: grace timer always waits the full period now (even with zero PTYs)
    // so a detached relay has time for a --connect client to arrive.
    relay = spawn(['--grace-time', '1'])
    await relay.sentinelReceived

    relay.proc.stdin!.end()

    await relay.waitForExit(5000)
    expect(relay.proc.exitCode).toBe(0)
  }, 10_000)

  it('registers root via request and returns acknowledgment', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('session.registerRoot', { rootPath: tmpDir })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ ok: true })

    const statId = relay.send('fs.stat', { filePath: path.join(tmpDir, 'test.txt') })
    const statResp = await relay.waitForResponse(statId)
    expect(statResp.error).toBeUndefined()
    expect((statResp.result as { type: string }).type).toBe('file')
  }, 10_000)

  it('rejects fs operations when no roots are registered', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')

    relay = spawn()
    await relay.sentinelReceived

    const id = relay.send('fs.stat', { filePath: path.join(tmpDir, 'test.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toContain('No workspace roots registered yet')
  }, 10_000)

  it('rejects paths outside registered roots', async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-sub-'))
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'relay-outside-'))
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')

    relay = spawn()
    await relay.sentinelReceived
    relay.sendNotification('session.registerRoot', { rootPath: tmpDir })

    const id = relay.send('fs.stat', { filePath: path.join(outsideDir, 'secret.txt') })
    const resp = await relay.waitForResponse(id)

    expect(resp.error).toBeDefined()
    expect(resp.error!.message).toContain('Path outside authorized workspace')

    await rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  }, 10_000)

  it('resolves ~ to home directory via session.resolveHome', async () => {
    relay = spawn()
    await relay.sentinelReceived

    const homeDir = require('os').homedir()

    const id1 = relay.send('session.resolveHome', { path: '~' })
    const id2 = relay.send('session.resolveHome', { path: '~/projects' })
    const id3 = relay.send('session.resolveHome', { path: '/absolute/path' })

    const [r1, r2, r3] = await Promise.all([
      relay.waitForResponse(id1),
      relay.waitForResponse(id2),
      relay.waitForResponse(id3)
    ])

    expect((r1.result as { resolvedPath: string }).resolvedPath).toBe(homeDir)
    expect((r2.result as { resolvedPath: string }).resolvedPath).toBe(
      path.join(homeDir, 'projects')
    )
    expect((r3.result as { resolvedPath: string }).resolvedPath).toBe('/absolute/path')
  }, 10_000)
})
