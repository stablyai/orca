import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { cursorBucketForCwd } from './session-scanner-cursor-paths'
import { parseCursorSidecarContent } from './session-scanner-cursor-sidecar'
import type { FileWithMtime } from './session-scanner-types'

function fileFor(
  cwd: string,
  platform: NodeJS.Platform,
  overrides: Partial<FileWithMtime> = {}
): FileWithMtime {
  const path =
    platform === 'win32'
      ? win32.join(
          'C:\\Users\\Ada\\.cursor\\chats',
          cursorBucketForCwd(cwd, platform),
          'opaque session',
          'meta.json'
        )
      : `/home/ada/.cursor/chats/${cursorBucketForCwd(cwd, platform)}/opaque session/meta.json`
  return {
    path,
    mtimeMs: 20,
    modifiedAt: '1970-01-01T00:00:00.020Z',
    sizeBytes: 100,
    cursorStoreMtimeMs: 30,
    ...overrides
  }
}

describe('parseCursorSidecarContent', () => {
  it('parses the documented schema and ignores schemaVersion and store-only fields', () => {
    const cwd = '/workspace/repo'
    const result = parseCursorSidecarContent({
      file: fileFor(cwd, 'linux'),
      platform: 'linux',
      content: JSON.stringify({
        schemaVersion: 99,
        createdAtMs: 10.9,
        updatedAtMs: 20.8,
        hasConversation: true,
        isSubagent: true,
        title: '  Session title  ',
        cwd,
        agentId: 'wrong-id',
        name: 'wrong-title',
        latestRootBlobId: 'private'
      })
    })

    expect(result.issue).toBeNull()
    expect(result.evidence).toMatchObject({
      sessionId: 'opaque session',
      title: 'Session title',
      createdAt: '1970-01-01T00:00:00.010Z',
      updatedAt: '1970-01-01T00:00:00.020Z',
      hasConversation: true,
      isSubagent: true,
      cwdEvidence: { kind: 'sidecar-bucket-match', cwd }
    })
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])(
    'silently skips an invalid createdAtMs value: %s',
    (createdAtMs) => {
      const result = parseCursorSidecarContent({
        file: fileFor('/repo', 'linux'),
        platform: 'linux',
        content: JSON.stringify({ createdAtMs, hasConversation: true })
      })
      expect(result).toEqual({ evidence: null, issue: null })
    }
  )

  it.each([undefined, 0, -1, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])(
    'falls back to the sibling store mtime for updatedAtMs %s',
    (updatedAtMs) => {
      const result = parseCursorSidecarContent({
        file: fileFor('/repo', 'linux', { cursorStoreMtimeMs: 42.9 }),
        platform: 'linux',
        content: JSON.stringify({ createdAtMs: 10, updatedAtMs, hasConversation: 1 })
      })
      expect(result.evidence).toMatchObject({
        updatedAt: '1970-01-01T00:00:00.042Z',
        hasConversation: false
      })
    }
  )

  it.each([undefined, 0, -1, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])(
    'skips when updatedAtMs and the sibling store mtime are unusable: %s',
    (cursorStoreMtimeMs) => {
      const result = parseCursorSidecarContent({
        file: fileFor('/repo', 'linux', { cursorStoreMtimeMs }),
        platform: 'linux',
        content: JSON.stringify({ createdAtMs: 10, updatedAtMs: 0, hasConversation: true })
      })
      expect(result).toEqual({ evidence: null, issue: null })
    }
  )

  it('reports malformed JSON without exposing the content', () => {
    const file = fileFor('/repo', 'linux')
    const result = parseCursorSidecarContent({
      file,
      platform: 'linux',
      executionHostId: 'ssh:dev',
      content: '{"secret":'
    })
    expect(result.evidence).toBeNull()
    expect(result.issue).toEqual({
      executionHostId: 'ssh:dev',
      agent: 'cursor',
      path: file.path,
      message: 'Malformed Cursor session metadata.'
    })
  })

  it('rejects relative cwd and records a bucket mismatch for an absolute cwd', () => {
    const file = fileFor('/correct', 'linux')
    const relative = parseCursorSidecarContent({
      file,
      platform: 'linux',
      content: JSON.stringify({ createdAtMs: 10, cwd: 'relative/repo' })
    })
    const mismatch = parseCursorSidecarContent({
      file,
      platform: 'linux',
      content: JSON.stringify({ createdAtMs: 10, cwd: '/wrong' })
    })
    expect(relative.evidence?.cwdEvidence).toBeNull()
    expect(relative.issue).toBeNull()
    expect(mismatch.evidence?.cwdEvidence).toBeNull()
    expect(mismatch.issue?.message).toContain('does not match')
  })

  it('uses Windows path semantics independently of the scanner platform', () => {
    const cwd = 'c:\\Users\\Ada\\repo'
    const result = parseCursorSidecarContent({
      file: fileFor(cwd, 'win32'),
      platform: 'win32',
      content: JSON.stringify({ createdAtMs: 10, hasConversation: true, cwd })
    })
    expect(result.evidence?.cwdEvidence).toEqual({
      kind: 'sidecar-bucket-match',
      cwd: win32.resolve(cwd)
    })
  })
})
