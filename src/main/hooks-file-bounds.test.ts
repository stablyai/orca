import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadHooks,
  MAX_HOOK_GITIGNORE_BYTES,
  MAX_ISSUE_COMMAND_BYTES,
  MAX_ORCA_YAML_BYTES,
  readIssueCommand,
  writeIssueCommand
} from './hooks'

describe('hook configuration file bounds', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-hook-file-bounds-'))
    roots.push(root)
    return root
  }

  function writeOversizedSparseFile(path: string, limit: number): void {
    writeFileSync(path, 'x')
    truncateSync(path, limit + 1)
  }

  it('fails closed on an oversized sparse orca.yaml', () => {
    const repoPath = makeRepo()
    writeOversizedSparseFile(join(repoPath, 'orca.yaml'), MAX_ORCA_YAML_BYTES)

    expect(loadHooks(repoPath)).toBeNull()
  })

  it('ignores an oversized local issue command while retaining the shared command', () => {
    const repoPath = makeRepo()
    mkdirSync(join(repoPath, '.orca'))
    writeOversizedSparseFile(join(repoPath, '.orca', 'issue-command'), MAX_ISSUE_COMMAND_BYTES)
    writeFileSync(join(repoPath, 'orca.yaml'), 'issueCommand: shared command\n')

    expect(readIssueCommand(repoPath)).toMatchObject({
      localContent: null,
      sharedContent: 'shared command',
      effectiveContent: 'shared command',
      source: 'shared'
    })
  })

  it('does not rewrite an oversized .gitignore when saving a local command', () => {
    const repoPath = makeRepo()
    const gitignorePath = join(repoPath, '.gitignore')
    writeOversizedSparseFile(gitignorePath, MAX_HOOK_GITIGNORE_BYTES)
    const originalSize = statSync(gitignorePath).size
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    writeIssueCommand(repoPath, 'local command')

    expect(statSync(gitignorePath).size).toBe(originalSize)
    expect(readFileSync(join(repoPath, '.orca', 'issue-command'), 'utf8')).toBe('local command\n')
  })
})
