import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'

vi.mock('./effective-hook-config', () => ({
  getEffectiveHooksFromConfig: (_repo: unknown, hooks: unknown) => hooks
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

/** Run a real archive script in a real shell, under a deadline short enough to test. */
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

// Why a real shell (#19334): this bug is invisible to a mock. Node's `exec({ timeout })` SIGTERMs
// the child and reports whatever it chose to do, so a hook that traps SIGTERM and exits 0 came
// back as a PASS — a hook cut off mid-archive, indistinguishable from one that finished its work.
describe.skipIf(process.platform === 'win32')('archive hook deadline', () => {
  it('fails a hook that traps SIGTERM and exits zero, despite its zero exit', async () => {
    const result = await runArchive("trap 'exit 0' TERM; sleep 30")
    expect(result.success).toBe(false)
    // Withheld, so the removal gate reads `unverifiable` rather than a pass.
    expect(result.exitCode).toBeUndefined()
    expect(result.output).toContain('timed out')
  }, 20_000)

  it('settles at the deadline even when the hook refuses to die', async () => {
    const started = Date.now()
    const result = await runArchive("trap '' TERM; sleep 30")
    expect(result.success).toBe(false)
    // A hook that ignores the signal must not hold a removal open until it finishes.
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('passes a hook that finishes inside its deadline', async () => {
    await expect(runArchive('echo archived')).resolves.toMatchObject({ success: true })
  })

  it('reports an observed non-zero exit as the exit it is', async () => {
    await expect(runArchive('exit 23')).resolves.toMatchObject({ success: false, exitCode: 23 })
  })
})
