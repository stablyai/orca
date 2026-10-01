import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { buildRgArgsForQuickOpen } from '../shared/quick-open-filter'
import { buildGitGrepArgs, buildRgArgs } from '../shared/text-search'

// A workspace folder inside the repo puts `.orca-preparing/<id>` (a full spare checkout) under the
// search root, untracked. Neither Quick Open nor text search may list its files.
let repo = ''

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    // rg and git grep exit 1 when nothing matched.
    const status =
      typeof error === 'object' && error !== null && 'status' in error ? error.status : 0
    if (status === 1) {
      return ''
    }
    throw error
  }
}

function hasRipgrep(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'orca-spare-search-')))
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'src', 'a.txt'), 'needle\n')
  run('git', ['init', '--quiet'])
  run('git', ['add', 'src'])
  await mkdir(join(repo, '.orca-preparing', '1-x', 'src'), { recursive: true })
  await writeFile(join(repo, '.orca-preparing', '1-x', 'src', 'a.txt'), 'needle\n')
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

it('keeps spare checkout files out of git grep text search', () => {
  const found = run('git', buildGitGrepArgs('needle', {})).split('\0').filter(Boolean)
  expect(found.join('\n')).toContain('src/a.txt')
  expect(found.join('\n')).not.toContain('.orca-preparing')
})

it.runIf(hasRipgrep())('keeps spare checkout files out of rg text search and Quick Open', () => {
  expect(run('rg', buildRgArgs('needle', '.', {}))).toContain('src/a.txt')
  expect(run('rg', buildRgArgs('needle', '.', {}))).not.toContain('.orca-preparing')
  const quickOpen = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes: [],
    forceSlashSeparator: true
  })
  const listed = run('rg', quickOpen.primary)
  expect(listed).toContain('src/a.txt')
  expect(listed).not.toContain('.orca-preparing')
})
