import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DirectoryWorkerClient from './command-path-directory-worker-client'
import { DetectionDirectoryWorkerClient } from './command-path-directory-worker-client'

const listing = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./command-path-directory-worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof DirectoryWorkerClient>()),
  readDetectionDirectoryViaWorker: listing.read
}))

import { findCommandsOnLocalPath } from './command-path-resolver'

const entry = pathToFileURL(path.join(__dirname, 'command-path-directory-worker-entry.ts')).href
const fixture = path.join(__dirname, 'command-path-directory-worker.test-fixtures.mjs')
const clients: DetectionDirectoryWorkerClient[] = []
let dir = ''

function client(factory: ConstructorParameters<typeof DetectionDirectoryWorkerClient>[0]) {
  const value = new DetectionDirectoryWorkerClient(factory)
  clients.push(value)
  listing.read.mockImplementation((directory: string) => value.read(directory))
  return value
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orca-detection-dir-'))
})

afterEach(async () => {
  for (const value of clients.splice(0)) {
    value.dispose()
  }
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('detection directory worker boundary', () => {
  it('keeps a plain Node CLI alive for pending listings and lets it exit while idle', async () => {
    await writeFile(path.join(dir, 'found'), '')
    const result = await runProcess({
      program: process.execPath,
      args: [fixture, dir],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 5_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(JSON.stringify([['found', 'found']]))
  })

  it('uses async executable probes when the worker cannot start', async () => {
    await writeFile(path.join(dir, 'found'), '')
    await chmod(path.join(dir, 'found'), 0o755)
    client(() => {
      throw new Error('worker unavailable')
    })
    await expect(
      findCommandsOnLocalPath(['found', 'b', 'c', 'd', 'e'], { env: { PATH: dir } })
    ).resolves.toEqual(new Set(['found']))
  })

  it('completes a listing while an unrelated directory read is still pending', async () => {
    const slowDir = path.join(dir, 'slow')
    const value = client(
      () =>
        new Worker(fixture, {
          workerData: { entry, blockedDirectory: slowDir }
        })
    )
    let settled = false
    const slow = value.read(slowDir).then((names) => {
      settled = true
      return names
    })
    await expect(value.read(dir)).resolves.toEqual(new Map())
    expect(settled).toBe(false)
    value.dispose()
    await expect(slow).resolves.toBeNull()
  })
})
