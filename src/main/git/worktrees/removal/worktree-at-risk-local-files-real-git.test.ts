import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorktreeAtRiskLocalFiles } from './worktree-at-risk-local-files'

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

describe('readWorktreeAtRiskLocalFiles (real git)', () => {
  let scratch = ''
  let mainPath = ''
  let worktreePath = ''

  beforeEach(async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'orca-at-risk-files-')))
    mainPath = join(scratch, 'main')
    worktreePath = join(scratch, 'feature')
    await mkdir(mainPath)
    git(['init', '-q'], mainPath)
    git(['config', 'user.email', 'test@example.com'], mainPath)
    git(['config', 'user.name', 'Test User'], mainPath)
    await writeFile(join(mainPath, '.gitignore'), '.env*\nnode_modules/\nlocal/\n*.log\n')
    git(['add', '.'], mainPath)
    git(['commit', '-qm', 'init'], mainPath)
    git(['worktree', 'add', '-q', '-b', 'feature', worktreePath], mainPath)
    await writeFile(join(mainPath, '.env'), 'TOKEN=main\n')
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  const read = () => readWorktreeAtRiskLocalFiles({ worktreePath, mainCheckoutPath: mainPath })

  it('reports an ignored .env that differs from the main checkout', async () => {
    await writeFile(join(worktreePath, '.env'), 'TOKEN=feature\n')
    await mkdir(join(worktreePath, 'local', 'notes'), { recursive: true })
    await writeFile(join(worktreePath, 'local', 'notes', 'todo.txt'), 'mine\n')

    await expect(read()).resolves.toEqual({
      count: 2,
      samplePaths: ['.env', 'local/'],
      complete: true
    })
  })

  // File symlinks need Developer Mode or admin rights on Windows.
  it.skipIf(process.platform === 'win32')(
    'ignores regenerable output, identical copies and symlinks',
    async () => {
      await mkdir(join(worktreePath, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(worktreePath, 'node_modules', 'pkg', 'index.js'), 'x\n')
      await writeFile(join(worktreePath, 'debug.log'), 'x\n')
      await writeFile(join(worktreePath, '.env'), 'TOKEN=main\n')
      await writeFile(join(mainPath, '.env.local'), 'LOCAL=1\n')
      await symlink(join(mainPath, '.env.local'), join(worktreePath, '.env.local'))

      await expect(read()).resolves.toEqual({ count: 0, samplePaths: [], complete: true })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not count a main-checkout symlink into the worktree as a copy',
    async () => {
      await rm(join(mainPath, '.env'))
      await writeFile(join(worktreePath, '.env'), 'TOKEN=feature\n')
      await symlink(join(worktreePath, '.env'), join(mainPath, '.env'))

      await expect(read()).resolves.toEqual({ count: 1, samplePaths: ['.env'], complete: true })
    }
  )

  it('reports a directory past its comparison budget as unchecked, not safe', async () => {
    await mkdir(join(worktreePath, 'local'))
    await mkdir(join(mainPath, 'local'))
    for (let index = 0; index < 1_001; index += 1) {
      await writeFile(join(worktreePath, 'local', `${index}.txt`), 'same\n')
      await writeFile(join(mainPath, 'local', `${index}.txt`), 'same\n')
    }

    await expect(read()).resolves.toEqual({ count: 0, samplePaths: [], complete: false })
  })
})
