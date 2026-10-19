import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// How many more renames out of each path fail the way Windows refuses a running executable.
const { refusals } = vi.hoisted(() => ({ refusals: new Map<string, number>() }))
function refuseIfListed(from: string): void {
  const left = refusals.get(from) ?? 0
  if (left > 0) {
    refusals.set(from, left - 1)
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), {
      code: 'EPERM'
    })
  }
}
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    refuseIfListed(String(from))
    actual.renameSync(from, to)
  }
  return { ...actual, renameSync, default: { ...actual, renameSync } }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  const rename: typeof actual.rename = async (from, to) => {
    refuseIfListed(String(from))
    await actual.rename(from, to)
  }
  return { ...actual, rename, default: { ...actual, rename } }
})

import { renameOverLockedTarget, renameOverLockedTargetAsync } from './locked-executable-rename'

const roots: string[] = []

afterEach(() => {
  refusals.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function stage(): { tmp: string; target: string; aside: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-locked-rename-'))
  roots.push(root)
  const tmp = join(root, '.next.tmp')
  const target = join(root, 'orca-agent-hook.exe')
  writeFileSync(tmp, 'next build')
  writeFileSync(target, 'running build')
  return { tmp, target, aside: `${target}.old` }
}

const replaceSync = async (...args: Parameters<typeof renameOverLockedTarget>): Promise<void> =>
  renameOverLockedTarget(...args)

describe.each([
  ['sync', replaceSync],
  ['async', renameOverLockedTargetAsync]
])('renameOverLockedTarget (%s)', (_mode, replace) => {
  it('moves a locked target aside and puts the new file in its place', async () => {
    const { tmp, target, aside } = stage()
    refusals.set(tmp, 1)

    await replace(tmp, target, true)

    expect(readFileSync(target, 'utf8')).toBe('next build')
    expect(readFileSync(aside, 'utf8')).toBe('running build')
  })

  it('restores the running copy when the new file then cannot take its name', async () => {
    const { tmp, target, aside } = stage()
    refusals.set(tmp, 2)

    await expect(replace(tmp, target, true)).rejects.toMatchObject({ code: 'EPERM' })

    expect(readFileSync(target, 'utf8')).toBe('running build')
    expect(existsSync(aside)).toBe(false)
    expect(readFileSync(tmp, 'utf8')).toBe('next build')
  })

  it('leaves a locked target in place when not asked to move it', async () => {
    const { tmp, target, aside } = stage()
    refusals.set(tmp, 1)

    await expect(replace(tmp, target, false)).rejects.toMatchObject({ code: 'EPERM' })

    expect(readFileSync(target, 'utf8')).toBe('running build')
    expect(existsSync(aside)).toBe(false)
  })
})
