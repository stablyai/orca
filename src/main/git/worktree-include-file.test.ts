import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWorktreeIncludePaths } from './worktree-include-file'

import { gitExecFileAsync } from './runner'

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn()
}))

const gitExecFileAsyncMock = vi.mocked(gitExecFileAsync)

/** Unset input ignores every requested path; exit 1 with empty stdout means none ignored. */
function mockCheckIgnore(ignored?: string[]): void {
  gitExecFileAsyncMock.mockImplementation(async (args, execOptions) => {
    if (!args.includes('check-ignore')) {
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    }
    const requested = (execOptions.stdin ?? '').split('\0').filter(Boolean)
    const ignoredSet = new Set(ignored ?? requested)
    const matched = requested.filter((path) => ignoredSet.has(path))
    if (matched.length === 0) {
      throw Object.assign(new Error('no matches'), { code: 1 })
    }
    return { stdout: matched.map((path) => `${path}\0`).join(''), stderr: '' }
  })
}

describe('resolveWorktreeIncludePaths', () => {
  let repo: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'orca-worktreeinclude-'))
    gitExecFileAsyncMock.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(repo, { recursive: true, force: true })
  })

  function writeInclude(content: string): void {
    writeFileSync(join(repo, '.worktreeinclude'), content)
  }

  it('resolves existing gitignored literal files and directories', async () => {
    writeInclude('.env\nconfig/secrets.json\n.vscode/\nmissing.txt\n')
    writeFileSync(join(repo, '.env'), 'A=1')
    mkdirSync(join(repo, 'config'))
    writeFileSync(join(repo, 'config', 'secrets.json'), '{}')
    mkdirSync(join(repo, '.vscode'))
    mockCheckIgnore(['.env', 'config/secrets.json', '.vscode'])

    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual([
      '.env',
      '.vscode',
      'config/secrets.json'
    ])
  })

  it('drops listed paths that exist but are not gitignored', async () => {
    writeInclude('.env\ntracked.json\n')
    writeFileSync(join(repo, '.env'), 'A=1')
    writeFileSync(join(repo, 'tracked.json'), '{}')
    mockCheckIgnore(['.env'])

    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual(['.env'])
  })

  it('skips glob and negation entries with a warning', async () => {
    writeInclude('.env.*\n!.env.production\n.env\n')
    writeFileSync(join(repo, '.env'), 'A=1')
    mockCheckIgnore(['.env'])

    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual(['.env'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported'))
  })

  it('rejects traversal, absolute, and .git entries', async () => {
    writeInclude('../outside\n/etc/passwd\n.git/config\n.env\n')
    writeFileSync(join(repo, '.env'), 'A=1')
    mockCheckIgnore(['.env'])

    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual(['.env'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsafe'))
  })

  it('stops after 1000 entries so one repo file cannot request unbounded work', async () => {
    const names = Array.from({ length: 1001 }, (_, index) => `ignored-${index}.env`)
    for (const name of names) {
      writeFileSync(join(repo, name), 'A=1')
    }
    writeInclude(`${names.join('\n')}\n`)
    mockCheckIgnore()

    const resolved = await resolveWorktreeIncludePaths(repo)

    expect(resolved).toHaveLength(1000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than 1000 entries'))
  })
})
