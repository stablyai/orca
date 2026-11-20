import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let directory: string
let entry: string
const fixture = path.join(__dirname, 'repo-worktree-admin-fingerprint-isolation.test-fixture.mjs')

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'orca-fingerprint-isolation-'))
  const outdir = path.join(directory, 'bundle')
  await build({
    entryPoints: [
      path.join(__dirname, 'repo-worktree-admin-fingerprint.ts'),
      path.join(__dirname, 'repo-worktree-admin-fingerprint-process-entry.ts')
    ],
    outdir,
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  entry = pathToFileURL(path.join(outdir, 'repo-worktree-admin-fingerprint.js')).href
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function probe(root: string) {
  return runProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [fixture, entry, root],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', UV_THREADPOOL_SIZE: '4' },
    timeoutMs: 15_000
  })
}

describe('Git admin fingerprint process isolation', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps directory reads usable after real blocked HEAD reads',
    async () => {
      const root = path.join(directory, 'blocked')
      for (const name of ['a', 'b', 'c', 'd']) {
        const git = path.join(root, name, '.git')
        await mkdir(git, { recursive: true })
        const fifo = await runProcess({ program: 'mkfifo', args: [path.join(git, 'HEAD')] })
        expect(fifo.code, fifo.stderr).toBe(0)
      }
      const result = await probe(root)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        fingerprints: ['unavailable', 'unavailable', 'unavailable', 'unavailable'],
        entries: ['a', 'b', 'c', 'd']
      })
    }
  )
})
