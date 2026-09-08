import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cursorProjectDirFromTranscriptPath,
  decodeCursorProjectSlug,
  resolveCursorTranscriptCwd
} from './session-scanner-cursor-project-cwd'

const tempDirs: string[] = []

afterEach(() => {
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
  it('returns the projects/<slug> dir for nested session transcripts', () => {
    expect(
      cursorProjectDirFromTranscriptPath(
        '/home/u/.cursor/projects/Users-u-repo/agent-transcripts/sid/sid.jsonl'
      )
    ).toBe('/home/u/.cursor/projects/Users-u-repo')
  })

  it('returns the projects/<slug> dir for flat agent-transcripts files', () => {
    expect(
      cursorProjectDirFromTranscriptPath(
        'C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\sid.jsonl'
      )
    ).toBe('C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc')
  })

  it('returns null when agent-transcripts is missing', () => {
    expect(cursorProjectDirFromTranscriptPath('/home/u/.cursor/projects/slug/sid.jsonl')).toBeNull()
  })
})

describe('decodeCursorProjectSlug', () => {
  it('reconstructs Windows drive paths used by Cursor on Windows', () => {
    expect(decodeCursorProjectSlug('c-Dev-simulations-opc')).toBe('C:\\Dev\\simulations\\opc')
  })

  it('reconstructs POSIX paths with the leading slash restored', () => {
    expect(decodeCursorProjectSlug('Users-ada-code-orca')).toBe('/Users/ada/code/orca')
  })

  it('rejects empty or relative junk slugs', () => {
    expect(decodeCursorProjectSlug('')).toBeNull()
    expect(decodeCursorProjectSlug('..')).toBeNull()
  })
})

describe('resolveCursorTranscriptCwd', () => {
  it('prefers .workspace-trusted workspacePath over slug decode', () => {
    const root = tempDir()
    const projectDir = join(root, 'projects', 'c-Dev-simulations-opc')
    const transcripts = join(projectDir, 'agent-transcripts', 'sid')
    mkdirSync(transcripts, { recursive: true })
    writeFileSync(
      join(projectDir, '.workspace-trusted'),
      JSON.stringify({
        trustedAt: '2026-08-12T00:00:00.000Z',
        workspacePath: 'C:\\Dev\\simulations\\opc'
      })
    )
    const filePath = join(transcripts, 'sid.jsonl')
    writeFileSync(filePath, '')
    expect(resolveCursorTranscriptCwd(filePath)).toBe('C:\\Dev\\simulations\\opc')
  })

  it('falls back to slug decode when the trust marker is absent', () => {
    const root = tempDir()
    const projectDir = join(root, 'projects', 'Users-ada-code-orca')
    const transcripts = join(projectDir, 'agent-transcripts')
    mkdirSync(transcripts, { recursive: true })
    const filePath = join(transcripts, 'session.jsonl')
    writeFileSync(filePath, '')
    expect(resolveCursorTranscriptCwd(filePath)).toBe('/Users/ada/code/orca')
  })
})
