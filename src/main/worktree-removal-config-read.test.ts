import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../shared/repo-types'
import { runRequiredWorktreeRemoveHook } from './worktree-remove-hook-gate'

const readFailure = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (readFailure.enabled) {
        throw Object.assign(new Error('read denied'), { code: 'EACCES' })
      }
      return actual.readFileSync(...args)
    }
  }
})

const roots: string[] = []
afterEach(() => {
  readFailure.enabled = false
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(content?: string): Repo {
  const path = mkdtempSync(join(tmpdir(), 'orca-remove-config-'))
  roots.push(path)
  if (content !== undefined) {
    writeFileSync(join(path, 'orca.yaml'), content)
  }
  return { id: 'fixture', path, displayName: 'fixture', badgeColor: '#000', addedAt: 0 }
}

describe('required removal configuration evidence', () => {
  it('does not run local cleanup or accept removal after the shared run-both command fails', async () => {
    const sharedScript = process.platform === 'win32' ? 'cmd /c exit 23' : 'false'
    const repo = fixture(`scripts:\n  remove: ${JSON.stringify(sharedScript)}`)
    const marker = join(repo.path, 'local-cleanup-ran')
    const localScript = `echo cleaned > "${marker}"`
    repo.hookSettings = {
      mode: 'auto',
      commandSourcePolicy: 'run-both',
      scripts: { setup: '', archive: '', remove: localScript }
    }
    const digest = createHash('sha256')
      .update(JSON.stringify([sharedScript, localScript]))
      .digest('hex')
    await expect(
      runRequiredWorktreeRemoveHook(repo, repo.path, undefined, digest)
    ).rejects.toMatchObject({ code: 'worktree_remove_hook_failed' })
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects an unknown private source policy rather than dropping local cleanup', async () => {
    const repo = fixture()
    repo.hookSettings = {
      mode: 'auto',
      commandSourcePolicy: 'local-only',
      scripts: { setup: '', archive: '', remove: 'dispose' }
    }
    Reflect.set(repo.hookSettings, 'commandSourcePolicy', 'unsupported-policy')
    await expect(runRequiredWorktreeRemoveHook(repo, repo.path)).rejects.toThrow(/configuration/i)
  })
  it.each([
    'scripts: [',
    'scripts:\n  remove: [dispose]',
    'scripts:\n  remove: one\n  remove: two'
  ])('refuses malformed shared configuration: %s', async (content) => {
    const repo = fixture(content)
    await expect(runRequiredWorktreeRemoveHook(repo, repo.path)).rejects.toThrow(/configuration/i)
  })

  it('refuses unreadable shared configuration instead of claiming no hook', async () => {
    const repo = fixture('scripts:\n  remove: dispose')
    readFailure.enabled = true
    await expect(runRequiredWorktreeRemoveHook(repo, repo.path)).rejects.toThrow(/configuration/i)
  })

  it('permits a missing hooks file and ignores malformed shared configuration under local-only', async () => {
    const missing = fixture()
    await expect(runRequiredWorktreeRemoveHook(missing, missing.path)).resolves.toBeUndefined()
    const local = fixture('scripts: [')
    local.hookSettings = {
      mode: 'auto',
      commandSourcePolicy: 'local-only',
      scripts: { setup: '', archive: '' }
    }
    await expect(runRequiredWorktreeRemoveHook(local, local.path)).resolves.toBeUndefined()
  })
})
