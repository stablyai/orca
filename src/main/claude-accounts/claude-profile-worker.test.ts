import { Worker } from 'node:worker_threads'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProfileSetupWorker } from './claude-profile-worker'
import { describeClaudeProfile } from './claude-profile-paths'
import { getManagedCommand, getManagedScriptPath } from '../claude/hook-settings'
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
/** A worker's os.homedir() reads the process HOME, never its own env; pin that to a sentinel first. */
async function pinWorkerHomedir(sentinel: string): Promise<void> {
  vi.stubEnv('HOME', sentinel)
  vi.stubEnv('USERPROFILE', sentinel)
  const probe = new Worker(
    "require('node:worker_threads').parentPort.postMessage(require('node:os').homedir())",
    { eval: true }
  )
  const seen = await new Promise((done) => probe.once('message', done))
  await probe.terminate()
  if (seen !== sentinel) {
    throw new Error(`worker homedir is ${String(seen)}, not the sentinel; refusing to run setup`)
  }
}
it('runs the ownership-gated setup and versioned hooks in a real worker under an isolated HOME', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-worker-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(home, '.claude', 'projects', 'cwd'), { recursive: true })
  mkdirSync(dataRoot)
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      statusLine: { type: 'command', command: getManagedCommand('/fake/claude-statusline.sh') }
    })
  )
  writeFileSync(join(home, '.claude', 'projects', 'cwd', 'session.jsonl'), '{"fake":true}\n')
  writeFileSync(join(home, '.claude', '.credentials.json'), 'fake-secret-must-stay')
  // Anything the worker writes through homedir() instead of the job's home lands here.
  const sentinel = join(root, 'process-home')
  mkdirSync(sentinel)
  await pinWorkerHomedir(sentinel)
  const outfile = join(root, 'profile-worker.cjs')
  await build({
    entryPoints: [resolve('src/main/claude-accounts/claude-profile-worker-entry.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })
  const threads: Worker[] = []
  const worker = new ClaudeProfileSetupWorker(() => {
    const thread = new Worker(outfile, {
      env: { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin', ORCA_BACKGROUND_LAUNCH: '1' }
    })
    threads.push(thread)
    return thread
  })
  const profile = describeClaudeProfile(dataRoot, 'a', {
    executionHostId: 'local',
    runtime: 'host'
  })
  try {
    const report = await worker.prepare({
      dataRoot,
      userHome: home,
      profile,
      hooksEnabled: true,
      claudeVersion: '2.1.261'
    })
    expect(threads).toHaveLength(1)
    expect(threads[0].threadId).toBeGreaterThan(0)
    expect(report).toMatchObject({ outcome: 'prepared', warnings: [] })
    const settings = JSON.parse(readFileSync(join(profile.home, 'settings.json'), 'utf8'))
    expect(settings.statusLine).toBeDefined()
    expect(settings.hooks.SessionEnd).toEqual(expect.any(Array))
    expect(readFileSync(join(profile.home, 'projects', 'cwd', 'session.jsonl'), 'utf8')).toBe(
      '{"fake":true}\n'
    )
    expect(existsSync(join(profile.home, '.credentials.json'))).toBe(false)
    expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe(
      'fake-secret-must-stay'
    )
    expect(existsSync(getManagedScriptPath(undefined, home))).toBe(true)
    expect(readdirSync(sentinel)).toEqual([])
  } finally {
    worker.dispose()
    await Promise.all(threads.map((thread) => thread.terminate()))
  }
})
it('never falls back to setup on the main thread when spawning a worker fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-worker-failure-'))
  roots.push(root)
  const profile = describeClaudeProfile(root, 'a', { executionHostId: 'local', runtime: 'host' })
  const worker = new ClaudeProfileSetupWorker(() => {
    throw new Error('worker unavailable')
  })
  try {
    await expect(
      worker.prepare({
        dataRoot: root,
        userHome: join(root, 'personal'),
        profile,
        hooksEnabled: false,
        claudeVersion: undefined
      })
    ).rejects.toThrow()
    expect(existsSync(profile.home)).toBe(false)
  } finally {
    worker.dispose()
  }
})
