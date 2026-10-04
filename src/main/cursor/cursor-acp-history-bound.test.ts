import type * as FsPromises from 'node:fs/promises'
import { runProcess } from '../../shared/child-process/run-process'
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const control = vi.hoisted(() => ({ path: '', grow: async () => {} }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    realpath: async (path: Parameters<typeof original.realpath>[0]) => {
      const found = await original.realpath(path)
      if (String(path) === control.path) {
        await control.grow()
      }
      return found
    }
  }
})
import { resolveCursorAcpHistorySource } from './cursor-acp-history-source'

it('refuses metadata that grows past the limit after the pre-read stat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cursor-metadata-growth-review-'))
  const accountHomePath = join(root, 'cursor'),
    providerSessionId = 'private',
    cwd = join(root, 'folder')
  const directory = join(accountHomePath, 'acp-sessions', providerSessionId)
  const metadata = join(directory, 'meta.json')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'store.db'), 'private fixture')
  await writeFile(metadata, JSON.stringify({ schemaVersion: 1, cwd }))
  control.path = metadata
  control.grow = () =>
    writeFile(metadata, JSON.stringify({ schemaVersion: 1, cwd, padding: 'x'.repeat(1024 * 1024) }))
  try {
    expect(
      await resolveCursorAcpHistorySource({ accountHomePath, providerSessionId, cwd })
    ).toBeNull()
  } finally {
    control.path = ''
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['directory', 'symlink', ...(process.platform === 'win32' ? [] : ['fifo'])])(
  'refuses an actual metadata swap to %s after stat without blocking',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-metadata-swap-'))
    const accountHomePath = join(root, 'cursor'),
      providerSessionId = 'private',
      cwd = join(root, 'folder')
    const directory = join(accountHomePath, 'acp-sessions', providerSessionId)
    const metadata = join(directory, 'meta.json')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'store.db'), 'fixture')
    await writeFile(metadata, JSON.stringify({ schemaVersion: 1, cwd }))
    let swapped = false
    control.path = metadata
    control.grow = async () => {
      control.path = ''
      await rm(metadata)
      if (kind === 'directory') {
        await mkdir(metadata)
      } else if (kind === 'symlink') {
        const outside = join(root, 'outside.json')
        await writeFile(outside, JSON.stringify({ schemaVersion: 1, cwd }))
        await symlink(outside, metadata)
      } else {
        const result = await runProcess({ program: 'mkfifo', args: [metadata], timeoutMs: 1000 })
        if (result.code !== 0) {
          throw new Error('Fixture FIFO creation failed')
        }
      }
      swapped = true
    }
    try {
      expect(
        await resolveCursorAcpHistorySource({
          accountHomePath,
          providerSessionId,
          cwd,
          timeoutMs: 500
        })
      ).toBeNull()
      expect(swapped).toBe(true)
    } finally {
      control.path = ''
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['cancellation', 'deadline'])(
  'returns promptly on %s during a pending metadata step',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-metadata-cancel-'))
    const accountHomePath = join(root, 'cursor'),
      providerSessionId = 'private',
      cwd = join(root, 'folder')
    const directory = join(accountHomePath, 'acp-sessions', providerSessionId)
    const metadata = join(directory, 'meta.json')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'store.db'), 'fixture')
    await writeFile(metadata, JSON.stringify({ schemaVersion: 1, cwd }))
    let release = () => {}
    let waiting = false
    control.path = metadata
    control.grow = () =>
      new Promise<void>((resolve) => {
        control.path = ''
        waiting = true
        release = resolve
      })
    const abort = new AbortController()
    try {
      const work = resolveCursorAcpHistorySource({
        accountHomePath,
        providerSessionId,
        cwd,
        signal: abort.signal,
        timeoutMs: mode === 'deadline' ? 20 : 2000
      })
      await vi.waitFor(() => expect(waiting).toBe(true))
      if (mode === 'cancellation') {
        abort.abort()
      }
      expect(await work).toBeNull()
      release()
    } finally {
      control.path = ''
      release()
      await rm(root, { recursive: true, force: true })
    }
  }
)
