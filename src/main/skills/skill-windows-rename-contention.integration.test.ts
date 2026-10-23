import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'

const RUN_REAL_WINDOWS =
  process.platform === 'win32' && process.env.ORCA_REAL_WINDOWS_SKILL_TEST === '1'
const roots: string[] = []
const lockers: {
  child: ChildProcessWithoutNullStreams
  closed: Promise<number | null>
}[] = []
let onRenameError: ((error: unknown) => Promise<void>) | undefined

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      try {
        await actual.rename(...args)
      } catch (error) {
        await onRenameError?.(error)
        throw error
      }
    })
  }
})

const LOCK_SCRIPT = [
  '$stream = [System.IO.File]::Open($env:ORCA_SKILL_LOCK_PATH, [System.IO.FileMode]::Open,',
  '  [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
  "[Console]::Out.WriteLine('LOCKED')",
  '$null = [Console]::In.ReadLine()',
  '$stream.Dispose()'
].join('\n')

function holdFile(path: string) {
  const child = spawnProcess({
    program: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', LOCK_SCRIPT],
    env: {
      ...process.env,
      ORCA_SKILL_LOCK_PATH: path
    }
  })
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
  lockers.push({ child, closed })
  let ready = false
  const locked = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('LOCKED')) {
        ready = true
        resolve()
      }
    })
    child.once('exit', (code) => {
      if (!ready) {
        reject(new Error(`windows-locker-exited-${code ?? 'unknown'}`))
      }
    })
  })
  return {
    locked,
    release: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end('\n')
      }
      expect(await closed).toBe(0)
    }
  }
}

async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `orca-windows-rename-${label}-`))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'target')
  const file = join(source, 'SKILL.md')
  await mkdir(source)
  await writeFile(file, 'private skill')
  return { source, target, file }
}

afterEach(async () => {
  onRenameError = undefined
  vi.clearAllMocks()
  await Promise.all(
    lockers.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
      await closed
    })
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(RUN_REAL_WINDOWS)('real Windows rename contention', () => {
  it('retries a transient exclusive file lock', async () => {
    const value = await fixture('transient')
    const lock = holdFile(value.file)
    await lock.locked

    // Release only after a real sharing violation, outside the retry timer budget.
    onRenameError = async (error) => {
      expect(error).toMatchObject({ code: expect.stringMatching(/^(EACCES|EBUSY|EPERM)$/) })
      onRenameError = undefined
      await lock.release()
    }
    await renameSkillPathWithWindowsRetry(value.source, value.target)

    expect(vi.mocked(rename).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(value.target, 'SKILL.md'), 'utf8')).toBe('private skill')
  })

  it('preserves the source after bounded retry exhaustion', async () => {
    const value = await fixture('exhaustion')
    const lock = holdFile(value.file)
    await lock.locked

    await expect(renameSkillPathWithWindowsRetry(value.source, value.target)).rejects.toMatchObject(
      {
        code: expect.stringMatching(/^(EACCES|EBUSY|EPERM)$/)
      }
    )
    expect((await stat(value.source)).isDirectory()).toBe(true)
    expect(rename).toHaveBeenCalledTimes(6)
    await lock.release()
    expect(await readFile(value.file, 'utf8')).toBe('private skill')

    await expect(
      renameSkillPathWithWindowsRetry(value.source, value.target)
    ).resolves.toBeUndefined()
  })
})
