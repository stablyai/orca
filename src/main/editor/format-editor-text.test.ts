import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_FORMATTER_INCLUDE } from '../../shared/editor/formatting/editor-formatter'
import type { Repo } from '../../shared/repository/repo-types'
import { formatEditorText } from './format-editor-text'

// A configured formatter commonly names a package-manager bin (`node_modules/.bin/prettier`),
// which on Windows is a .cmd shim: spawning it without resolving the shim fails with ENOENT.
describe('project formatter execution', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function projectWith(command: string): Promise<{
    store: { getRepos: () => Repo[] }
    target: {
      path: string
      executionHostId: 'local'
      worktree: { path: string; repoId: string }
    }
  }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-formatter-'))
    roots.push(root)
    await writeFile(join(root, 'a.ts'), 'disk baseline')
    const repo: Repo = {
      id: 'repo',
      path: root,
      displayName: 'Project',
      badgeColor: '',
      addedAt: 0,
      kind: 'folder',
      editorFormatter: { command, include: [DEFAULT_FORMATTER_INCLUDE] }
    }
    return {
      store: { getRepos: () => [repo] },
      target: {
        path: join(root, 'a.ts'),
        executionHostId: 'local',
        worktree: { path: root, repoId: 'repo' }
      }
    }
  }

  it('skips a repository with no formatter configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-formatter-'))
    roots.push(root)
    const repo: Repo = {
      id: 'repo',
      path: root,
      displayName: 'Project',
      badgeColor: '',
      addedAt: 0,
      kind: 'folder'
    }
    const store = { getRepos: () => [repo] }
    const target = {
      path: join(root, 'a.ts'),
      executionHostId: 'local' as const,
      worktree: { path: root, repoId: 'repo' }
    }
    await expect(formatEditorText(store, target, 'text')).resolves.toEqual({ kind: 'skipped' })
  })

  it('runs a resolved formatter and returns its output', async () => {
    const script = [
      'let s = ""',
      'process.stdin.setEncoding("utf8")',
      'process.stdin.on("data", (x) => (s += x))',
      'process.stdin.on("end", () => process.stdout.write(s.trim() + "\\n"))'
    ].join(';')
    const { store, target } = await projectWith(`"${process.execPath}" -e '${script}'`)
    await expect(formatEditorText(store, target, '  padded  ')).resolves.toEqual({
      kind: 'formatted',
      text: 'padded\n'
    })
  })

  it('reports a formatter that produced no text for a non-empty buffer', async () => {
    const script = 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(""))'
    const { store, target } = await projectWith(`"${process.execPath}" -e '${script}'`)
    await expect(formatEditorText(store, target, 'anything')).rejects.toThrow(
      'Formatter returned no text for a non-empty buffer.'
    )
  })
})
