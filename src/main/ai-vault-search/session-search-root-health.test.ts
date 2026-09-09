import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { degradedSessionSearchRoots } from './session-search-root-health'

const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ss-root-health-'))
  roots.push(root)
  return root
}

function discovery(rootDir: string, files: number): SessionFileDiscovery {
  return {
    agent: 'claude',
    rootDir,
    files: Array.from({ length: files }, (_unused, index) => ({
      path: join(rootDir, `${index}.jsonl`),
      mtimeMs: 0,
      modifiedAt: new Date(0).toISOString()
    }))
  }
}

it('leaves an agent that is simply not installed alone', async () => {
  const root = await tempRoot()
  expect(await degradedSessionSearchRoots([discovery(join(root, 'never-created'), 0)], [])).toEqual(
    []
  )
})

it('never probes a root that returned files', async () => {
  // The path does not exist, so a probe would report it degraded; a root that
  // yielded transcripts is readable by construction and must not be re-checked.
  expect(await degradedSessionSearchRoots([discovery('/definitely/not/here', 3)], [])).toEqual([])
})

it.skipIf(!CAN_DENY_READ)('names a root that exists but cannot be read', async () => {
  const root = await tempRoot()
  const blocked = join(root, 'blocked')
  await mkdir(blocked)
  await chmod(blocked, 0o000)
  try {
    const degraded = await degradedSessionSearchRoots([discovery(blocked, 0)], [])
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.root).toBe(blocked)
    expect(degraded[0]?.reason).toContain('EACCES')
  } finally {
    await chmod(blocked, 0o755)
  }
})

it('carries a root-level scan issue through, but not a per-file notice', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'healthy'))
  const rootDir = join(root, 'healthy')
  const degraded = await degradedSessionSearchRoots(
    [discovery(rootDir, 2)],
    [
      { agent: 'claude', path: rootDir, message: 'The distro stopped responding.' },
      { agent: 'claude', path: rootDir, kind: 'notice', message: 'issue list truncated' },
      { agent: 'claude', path: join(rootDir, 'one.jsonl'), message: 'a single unreadable file' }
    ]
  )
  expect(degraded).toEqual([{ root: rootDir, reason: 'The distro stopped responding.' }])
})
