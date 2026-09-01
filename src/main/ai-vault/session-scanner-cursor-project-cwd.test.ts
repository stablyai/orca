import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorWorkspaceSlug } from '../../shared/cursor-workspace-slug'
import {
  cursorProjectDirFromTranscriptPath,
  resetCursorTrustedCwdCacheForTests,
  resolveCursorTranscriptCwd
} from './session-scanner-cursor-project-cwd'

const tempDirs: string[] = []

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
      cursorProjectDirFromTranscriptPath('/tmp/unrelated/agent-transcripts/sid.jsonl')
    ).toBeNull()
  })
})

describe('resolveCursorTranscriptCwd', () => {
  it('prefers .workspace-trusted workspacePath over slug decode', () => {
    const root = tempDir()
    const projectDir = join(root, '.cursor', 'projects', 'c-Dev-simulations-opc')
    const transcripts = join(projectDir, 'agent-transcripts', 'sid')
    mkdirSync(transcripts, { recursive: true })
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({
        trustedAt: '2026-08-12T00:00:00.000Z',
        workspacePath: 'C:\\Dev\\simulations\\opc'
      })
    )
    expect(resolveCursorTranscriptCwd(join(transcripts, 'sid.jsonl'))).toBe(
      'C:\\Dev\\simulations\\opc'
    )
  })

  it('reads the drive-letter sibling trust file Cursor and Orca can split', () => {
    const root = tempDir()
    const cursorDir = join(root, '.cursor', 'projects', 'c-Dev-simulations-opc')
    const orcaDir = join(root, '.cursor', 'projects', 'C-Dev-simulations-opc')
    mkdirSync(join(cursorDir, 'agent-transcripts'), { recursive: true })
    mkdirSync(orcaDir, { recursive: true })
    writeFileSync(
      join(orcaDir, '.workspace-trusted'),
      JSON.stringify({ workspacePath: 'C:\\Dev\\simulations\\opc' })
    )
    expect(resolveCursorTranscriptCwd(join(cursorDir, 'agent-transcripts', 'sid.jsonl'))).toBe(
      'C:\\Dev\\simulations\\opc'
    )
  })

  it('publishes a decoded slug only when that workspace path exists', () => {
    const workspace = join(tmpdir(), 'orcacwdopc')
    mkdirSync(workspace, { recursive: true })
    tempDirs.push(workspace)
    const root = tempDir()
    const projectDir = join(root, '.cursor', 'projects', cursorWorkspaceSlug(workspace))
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
    expect(resolveCursorTranscriptCwd(join(projectDir, 'agent-transcripts', 'session.jsonl'))).toBe(
      workspace
    )
  })

  it('does not invent a cwd for a hyphenated folder slug whose decode does not exist', () => {
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
    expect(
      resolveCursorTranscriptCwd(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\projects\\home-ada-repo\\agent-transcripts\\sid.jsonl'
      )
    ).toBeNull()
  })

  it('picks up a trust file written after an earlier miss once the scan cache resets', () => {
    const root = tempDir()
    const projectDir = join(root, '.cursor', 'projects', 'c-Dev-simulations-opc')
    const filePath = join(projectDir, 'agent-transcripts', 'sid.jsonl')
    mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
    expect(resolveCursorTranscriptCwd(filePath)).toBeNull()
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({ workspacePath: 'C:\\Dev\\simulations\\opc' })
    )
    expect(resolveCursorTranscriptCwd(filePath)).toBeNull()
    resetCursorTrustedCwdCacheForTests()
    expect(resolveCursorTranscriptCwd(filePath)).toBe('C:\\Dev\\simulations\\opc')
  })

  it('skips the local trust file when remote content is parsed', () => {
    const root = tempDir()
    const projectDir = join(root, '.cursor', 'projects', 'c-Dev-simulations-opc')
    const transcripts = join(projectDir, 'agent-transcripts')
    mkdirSync(transcripts, { recursive: true })
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({ workspacePath: 'C:\\Dev\\simulations\\my-project' })
    )
    expect(resolveCursorTranscriptCwd(join(transcripts, 'sid.jsonl'))).toBe(
      'C:\\Dev\\simulations\\my-project'
    )
    expect(
      resolveCursorTranscriptCwd(join(transcripts, 'sid.jsonl'), { readTrustFile: false })
    ).toBeNull()
  })
})
