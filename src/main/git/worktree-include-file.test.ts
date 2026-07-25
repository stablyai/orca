import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWorktreeIncludeFile, resolveWorktreeIncludePaths } from './worktree-include-file'
import { gitExecFileAsync } from './runner'

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn()
}))

const gitExecFileAsyncMock = vi.mocked(gitExecFileAsync)

/** check-ignore echoes back every stdin path present in `ignored` (all requested
 *  when unset); exit code 1 with empty stdout means "none ignored". */
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

describe('parseWorktreeIncludeFile', () => {
  it('skips blank lines and comments, dedupes, strips ./ and trailing slash', () => {
    const entries = parseWorktreeIncludeFile(
      '# secrets\n\n.env\n  \n# more\n./config/secrets.json\n.vscode/\n.env\n'
    )
    expect(entries).toEqual(['.env', 'config/secrets.json', '.vscode'])
  })

  it('normalizes backslashes to forward slashes', () => {
    expect(parseWorktreeIncludeFile('apps\\web\\.env\n')).toEqual(['apps/web/.env'])
  })
})

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

  it('returns [] without spawning git when the file is absent', async () => {
    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual([])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

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

  it('skips a listed path that is absent from the primary checkout', async () => {
    writeInclude('.env\nnode_modules\n')
    writeFileSync(join(repo, '.env'), 'A=1')
    mockCheckIgnore(['.env'])

    // node_modules absent (not installed yet) → not stat-able → not requested from git.
    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual(['.env'])
  })

  it('resolves a gitignored symlink entry without following it', async () => {
    writeInclude('.env\n')
    writeFileSync(join(repo, '.env.real'), 'A=1')
    symlinkSync(join(repo, '.env.real'), join(repo, '.env'))
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

  it('resolves to [] when git fails instead of throwing', async () => {
    writeInclude('.env\n')
    writeFileSync(join(repo, '.env'), 'A=1')
    gitExecFileAsyncMock.mockRejectedValue(new Error('git exploded'))

    await expect(resolveWorktreeIncludePaths(repo)).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve'),
      expect.any(Error)
    )
  })
})
