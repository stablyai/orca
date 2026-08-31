import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cursorWorkspaceSlug } from '../../shared/cursor-workspace-slug'
import {
  cursorProjectDirFromTranscriptPath,
  resetCursorTrustedCwdCacheForTests,
  resolveCursorTranscriptCwd
} from './session-scanner-cursor-project-cwd'

const tempDirs: string[] = []
const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMocks.existsSync.mockImplementation(actual.existsSync)
  fsMocks.readFileSync.mockImplementation(actual.readFileSync)
  return { ...actual, existsSync: fsMocks.existsSync, readFileSync: fsMocks.readFileSync }
})

beforeEach(async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  fsMocks.existsSync.mockReset().mockImplementation(actual.existsSync)
  fsMocks.readFileSync.mockReset().mockImplementation(actual.readFileSync)
})

afterEach(() => {
  resetCursorTrustedCwdCacheForTests()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-cwd-'))
  tempDirs.push(dir)
  return dir
}

describe('cursorProjectDirFromTranscriptPath', () => {
  it('returns the projects/<slug> dir only for Cursor transcript layouts', () => {
    expect(
      cursorProjectDirFromTranscriptPath(
        '/home/u/.cursor/projects/Users-u-repo/agent-transcripts/sid/sid.jsonl'
      )
    ).toBe('/home/u/.cursor/projects/Users-u-repo')
    expect(
      cursorProjectDirFromTranscriptPath(
        'C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\sid.jsonl'
      )
    ).toBe('C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc')
    expect(
      cursorProjectDirFromTranscriptPath(
        '\\\\server\\share\\Users\\u\\.cursor\\projects\\c-repo\\agent-transcripts\\sid.jsonl'
      )
    ).toBe('\\\\server\\share\\Users\\u\\.cursor\\projects\\c-repo')
    expect(
      cursorProjectDirFromTranscriptPath(
        'C:\\Users/u/.cursor/projects/c-repo\\agent-transcripts/sid.jsonl'
      )
    ).toBe('C:\\Users\\u\\.cursor\\projects\\c-repo')
    expect(
      cursorProjectDirFromTranscriptPath('/tmp/unrelated/agent-transcripts/sid.jsonl')
    ).toBeNull()
  })
})

describe('resolveCursorTranscriptCwd', () => {
  it('uses a matching absolute .workspace-trusted workspacePath', () => {
    const root = tempDir()
    const workspace = join(root, 'simulations', 'opc')
    const projectDir = join(root, '.cursor', 'projects', cursorWorkspaceSlug(workspace))
    const transcripts = join(projectDir, 'agent-transcripts', 'sid')
    mkdirSync(transcripts, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({
        trustedAt: '2026-08-12T00:00:00.000Z',
        workspacePath: workspace
      })
    )
    expect(resolveCursorTranscriptCwd(join(transcripts, 'sid.jsonl'))).toBe(workspace)
  })

  it('reads the drive-letter sibling trust file Cursor and Orca can split', () => {
    const filePath =
      'C:\\Users\\ada\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\sid.jsonl'
    fsMocks.readFileSync.mockImplementationOnce(() => {
      throw new Error('missing primary marker')
    })
    fsMocks.readFileSync.mockReturnValueOnce(
      JSON.stringify({ workspacePath: 'C:\\Dev\\simulations\\opc' })
    )

    expect(resolveCursorTranscriptCwd(filePath)).toBe('C:\\Dev\\simulations\\opc')
    expect(fsMocks.readFileSync.mock.calls.map(([path]) => String(path))).toEqual([
      'C:\\Users\\ada\\.cursor\\projects\\c-Dev-simulations-opc\\.workspace-trusted',
      'C:\\Users\\ada\\.cursor\\projects\\C-Dev-simulations-opc\\.workspace-trusted'
    ])
  })

  it('does not publish a decoded cwd when two existing paths share a slug', () => {
    const collisionRoot = join(
      tmpdir(),
      `orcacwdcollision${process.pid}${Math.random().toString(16).slice(2)}`
    )
    const workspace = join(collisionRoot, 'team-repo')
    const decoded = join(collisionRoot, 'team', 'repo')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(decoded, { recursive: true })
    tempDirs.push(collisionRoot)
    const root = tempDir()
    const projectDir = join(root, '.cursor', 'projects', cursorWorkspaceSlug(workspace))
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
    expect(
      resolveCursorTranscriptCwd(join(projectDir, 'agent-transcripts', 'session.jsonl'))
    ).toBeNull()
  })

  it.each([
    ['a POSIX lookalike', '/c/repo'],
    ['the wrong drive', 'D:\\repo'],
    ['a different workspace on the same drive', 'C:\\other']
  ])('rejects a drive-case sibling marker for %s', (_case, workspacePath) => {
    const filePath = 'C:\\Users\\ada\\.cursor\\projects\\c-repo\\agent-transcripts\\sid.jsonl'
    fsMocks.readFileSync.mockImplementationOnce(() => {
      throw new Error('missing primary marker')
    })
    fsMocks.readFileSync.mockReturnValueOnce(JSON.stringify({ workspacePath }))

    expect(resolveCursorTranscriptCwd(filePath)).toBeNull()
    expect(fsMocks.readFileSync.mock.calls.map(([path]) => String(path))).toEqual([
      'C:\\Users\\ada\\.cursor\\projects\\c-repo\\.workspace-trusted',
      'C:\\Users\\ada\\.cursor\\projects\\C-repo\\.workspace-trusted'
    ])
  })

  it('does not inspect a drive-case sibling for a POSIX project bucket', () => {
    const root = tempDir()
    const cursorDir = join(root, '.cursor', 'projects', 'c-repo')
    mkdirSync(join(cursorDir, 'agent-transcripts'), { recursive: true })
    fsMocks.readFileSync.mockImplementationOnce(() => {
      throw new Error('missing primary marker')
    })
    fsMocks.readFileSync.mockReturnValueOnce(JSON.stringify({ workspacePath: '/c/repo' }))

    fsMocks.readFileSync.mockClear()
    expect(resolveCursorTranscriptCwd(join(cursorDir, 'agent-transcripts', 'sid.jsonl'))).toBeNull()
    expect(fsMocks.readFileSync.mock.calls.map(([path]) => String(path))).toEqual([
      join(cursorDir, '.workspace-trusted')
    ])
  })

  it.each([
    ['a stale absolute path', '/other/repo'],
    ['a relative path', 'repo']
  ])('rejects a primary marker with %s', (_case, workspacePath) => {
    const root = tempDir()
    const projectDir = join(root, '.cursor', 'projects', 'home-ada-repo')
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
    writeFileSync(join(projectDir, '.workspace-trusted'), JSON.stringify({ workspacePath }))

    expect(
      resolveCursorTranscriptCwd(join(projectDir, 'agent-transcripts', 'sid.jsonl'))
    ).toBeNull()
  })

  it('does not invent a cwd for a hyphenated folder slug without trusted metadata', () => {
    const root = tempDir()
    const projectDir = join(
      root,
      '.cursor',
      'projects',
      'c-Users-neil-orca-workspaces-orca-pr-13935-internal-review'
    )
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
    expect(
      resolveCursorTranscriptCwd(join(projectDir, 'agent-transcripts', 'session.jsonl'))
    ).toBeNull()
  })

  it('does not read a trust file or invent cwd for a WSL UNC transcript path', () => {
    fsMocks.existsSync.mockClear()
    fsMocks.readFileSync.mockClear()
    expect(
      resolveCursorTranscriptCwd(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\projects\\home-ada-repo\\agent-transcripts\\sid.jsonl'
      )
    ).toBeNull()
    expect(fsMocks.existsSync).not.toHaveBeenCalled()
    expect(fsMocks.readFileSync).not.toHaveBeenCalled()
  })

  it('picks up a trust file written after an earlier miss once the scan cache resets', () => {
    const root = tempDir()
    const workspace = join(root, 'simulations', 'opc')
    const projectDir = join(root, '.cursor', 'projects', cursorWorkspaceSlug(workspace))
    const filePath = join(projectDir, 'agent-transcripts', 'sid.jsonl')
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
    mkdirSync(workspace, { recursive: true })
    expect(resolveCursorTranscriptCwd(filePath)).toBeNull()
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({ workspacePath: workspace })
    )
    expect(resolveCursorTranscriptCwd(filePath)).toBeNull()
    resetCursorTrustedCwdCacheForTests()
    expect(resolveCursorTranscriptCwd(filePath)).toBe(workspace)
  })

  it('skips the local trust file when remote content is parsed', () => {
    const root = tempDir()
    const workspace = join(root, 'simulations', 'opc')
    const projectDir = join(root, '.cursor', 'projects', cursorWorkspaceSlug(workspace))
    const transcripts = join(projectDir, 'agent-transcripts')
    mkdirSync(transcripts, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({ workspacePath: workspace })
    )
    expect(resolveCursorTranscriptCwd(join(transcripts, 'sid.jsonl'))).toBe(workspace)
    expect(
      resolveCursorTranscriptCwd(join(transcripts, 'sid.jsonl'), { readTrustFile: false })
    ).toBeNull()
  })
})
