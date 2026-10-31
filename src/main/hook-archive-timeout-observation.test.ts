import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'

vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: (_repo: unknown, hooks: unknown) => hooks
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

async function runArchive(script: string, timeoutMs = 400) {
  const { runHook } = await import('./hooks')
  const dir = mkdtempSync(join(tmpdir(), 'orca-hook-deadline-'))
  writeFileSync(join(dir, 'orca.yaml'), `scripts:\n  archive: |\n    ${script}\n`)
  try {
    return await runHook('archive', dir, REPO, dir, undefined, timeoutMs)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Real shells expose SIGTERM traps that exit 0 after an archive timeout (#19334).
describe.skipIf(process.platform === 'win32')('archive hook deadline', () => {
  it('fails a hook that traps SIGTERM and exits zero, despite its zero exit', async () => {
    const result = await runArchive("trap 'exit 0' TERM; sleep 30")
    expect(result.success).toBe(false)
    // Missing exitCode keeps the removal verdict unverifiable.
    expect(result.exitCode).toBeUndefined()
    expect(result.output).toContain('timed out')
  }, 20_000)

  it('settles at the deadline even when the hook refuses to die', async () => {
    const started = Date.now()
    const result = await runArchive("trap '' TERM; sleep 30")
    expect(result.success).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('passes a hook that finishes inside its deadline', async () => {
    await expect(runArchive('echo archived')).resolves.toMatchObject({ success: true })
  })

  it('reports an observed non-zero exit as the exit it is', async () => {
    await expect(runArchive('exit 23')).resolves.toMatchObject({ success: false, exitCode: 23 })
  })
})
