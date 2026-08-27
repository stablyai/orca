import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'

const RUN_REAL_WINDOWS =
  process.platform === 'win32' && process.env.ORCA_REAL_WINDOWS_SKILL_TEST === '1'
const roots: string[] = []
const lockers: ChildProcessWithoutNullStreams[] = []

const LOCK_SCRIPT = [
  '$stream = [System.IO.File]::Open($env:ORCA_SKILL_LOCK_PATH, [System.IO.FileMode]::Open,',
  '  [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
  "[Console]::Out.WriteLine('LOCKED')",
  'Start-Sleep -Milliseconds ([int]$env:ORCA_SKILL_LOCK_DURATION_MS)',
  '$stream.Dispose()'
].join('\n')

function holdFile(path: string, durationMs: number) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', LOCK_SCRIPT],
    {
      windowsHide: true,
      env: {
        ...process.env,
        ORCA_SKILL_LOCK_PATH: path,
        ORCA_SKILL_LOCK_DURATION_MS: String(durationMs)
      }
    }
  )
  lockers.push(child)
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
  const released = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else if (ready) {
        reject(new Error(`windows-locker-exited-${code ?? 'unknown'}`))
      } else {
        resolve()
      }
    })
  })
  return { locked, released }
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
  for (const child of lockers.splice(0)) {
    if (child.exitCode === null) {
      child.kill()
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(RUN_REAL_WINDOWS)('real Windows rename contention', () => {
  it('retries a transient exclusive file lock', async () => {
    const value = await fixture('transient')
    const lock = holdFile(value.file, 300)
    await lock.locked

    await renameSkillPathWithWindowsRetry(value.source, value.target)
    await lock.released

    expect(await readFile(join(value.target, 'SKILL.md'), 'utf8')).toBe('private skill')
  })

  it('preserves the source after bounded retry exhaustion', async () => {
    const value = await fixture('exhaustion')
    const lock = holdFile(value.file, 2_000)
    await lock.locked

    await expect(renameSkillPathWithWindowsRetry(value.source, value.target)).rejects.toMatchObject(
      {
        code: expect.stringMatching(/^(EACCES|EBUSY|EPERM)$/)
      }
    )
    expect((await stat(value.source)).isDirectory()).toBe(true)
    await lock.released
    expect(await readFile(value.file, 'utf8')).toBe('private skill')

    await expect(
      renameSkillPathWithWindowsRetry(value.source, value.target)
    ).resolves.toBeUndefined()
  })
})
