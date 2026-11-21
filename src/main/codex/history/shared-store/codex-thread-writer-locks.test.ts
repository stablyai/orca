import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHost from '@orca/process-host'

const missingPrograms = new Set<string>()

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  // A helper program this machine lacks: its spawn fails as missing.
  return {
    ...actual,
    spawnProcess: (spec: Parameters<typeof actual.spawnProcess>[0]) =>
      actual.spawnProcess(
        missingPrograms.has(spec.program.split('/').pop() ?? '')
          ? { ...spec, program: join(tmpdir(), 'orca-no-such-program', spec.program) }
          : spec
      )
  }
})

const { moveIdleThreadLockFolder } = await import('./codex-thread-writer-locks')

const THREAD_LOCK = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.lock'
const hasFlock =
  process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v flock']).status === 0

// Holds a thread lock the way Codex does on Linux: flock(2) on the file, until stdin closes.
async function holdWithFlock(lock: string): Promise<() => Promise<void>> {
  const holder = spawn('sh', ['-c', 'exec 9<"$1"; flock 9; echo locked; read x', 'sh', lock])
  const closed = new Promise((resolve) => holder.once('close', resolve))
  await createInterface({ input: holder.stdout })[Symbol.asyncIterator]().next()
  return async () => {
    holder.stdin.end()
    await closed
  }
}

describe.skipIf(process.platform === 'win32')('moveIdleThreadLockFolder without perl', () => {
  let root: string
  let account: string
  let store: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-thread-locks-'))
    account = join(root, 'account')
    store = join(root, 'store')
    mkdirSync(join(account, 'thread-writer-locks'), { recursive: true })
    mkdirSync(join(store, 'thread-writer-locks'), { recursive: true })
    missingPrograms.add('perl')
  })

  afterEach(() => {
    missingPrograms.clear()
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!hasFlock)('moves an idle lock folder holding it through sh and flock', async () => {
    writeFileSync(join(account, 'thread-writer-locks', THREAD_LOCK), '')
    const move = vi.fn(async () => {})

    await expect(moveIdleThreadLockFolder(account, store, move)).resolves.toBe('moved')
    expect(move).toHaveBeenCalledTimes(1)
  })

  it.skipIf(!hasFlock)('reports a thread lock another process holds as held', async () => {
    const lock = join(account, 'thread-writer-locks', THREAD_LOCK)
    writeFileSync(lock, '')
    const release = await holdWithFlock(lock)
    const move = vi.fn(async () => {})
    try {
      await expect(moveIdleThreadLockFolder(account, store, move)).resolves.toBe('held')
    } finally {
      await release()
    }
    expect(move).not.toHaveBeenCalled()
  })

  it('never moves an idle lock folder when no helper can start', async () => {
    missingPrograms.add('sh')
    const move = vi.fn(async () => {})

    await expect(moveIdleThreadLockFolder(account, store, move)).resolves.toBe('no-helper')
    expect(move).not.toHaveBeenCalled()
  })
})
