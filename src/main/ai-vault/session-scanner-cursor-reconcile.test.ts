import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { cursorBucketForCwd } from './session-scanner-cursor-paths'
import {
  reconcileCursorCandidates,
  type ParsedCursorCandidate
} from './session-scanner-cursor-reconcile'
import type { CursorSidecarEvidence } from './session-scanner-cursor-sidecar'
import type { FileWithMtime } from './session-scanner-types'

function file(path: string, mtimeMs = 20): FileWithMtime {
  return {
    path,
    mtimeMs,
    modifiedAt: new Date(mtimeMs).toISOString(),
    cursorStoreMtimeMs: mtimeMs
  }
}

function sidecar(
  args: {
    id?: string
    cwd?: string
    bucket?: string
    context?: string
    conversation?: boolean
    subagent?: boolean
  } = {}
): ParsedCursorCandidate {
  const id = args.id ?? 'session'
  const cwd = args.cwd ?? '/repo'
  const bucket = args.bucket ?? cursorBucketForCwd(cwd, 'linux')
  const sidecarFile = file(`/home/ada/.cursor/chats/${bucket}/${id}/meta.json`)
  const evidence: CursorSidecarEvidence = {
    sessionId: id,
    title: 'Sidecar title',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:01:00.000Z',
    hasConversation: args.conversation ?? true,
    isSubagent: args.subagent ?? false,
    file: sidecarFile,
    cwdEvidence: { kind: 'sidecar-bucket-match', cwd }
  }
  return {
    layout: 'sidecar',
    storageContextKey: args.context ?? 'native',
    file: sidecarFile,
    sidecar: evidence
  }
}

function legacy(
  args: {
    id?: string
    context?: string
    path?: string
    messageCount?: number
  } = {}
): ParsedCursorCandidate {
  const id = args.id ?? 'session'
  const transcript = file(
    args.path ?? `/home/ada/.cursor/projects/repo/agent-transcripts/${id}/${id}.jsonl`
  )
  const session: AiVaultSession = {
    id: `local:cursor:${id}:${transcript.path}`,
    executionHostId: 'local',
    executionHostPlatform: 'linux',
    agent: 'cursor',
    sessionId: id,
    title: 'Legacy title',
    cwd: null,
    branch: 'feature',
    model: null,
    filePath: transcript.path,
    codexHome: null,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    modifiedAt: '2026-07-02T00:00:00.000Z',
    messageCount: args.messageCount ?? 2,
    totalTokens: 10,
    previewMessages: [{ role: 'user', text: 'hello', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: "cursor-agent --resume 'session'",
    subagent: null
  }
  return {
    layout: 'legacy',
    storageContextKey: args.context ?? 'native',
    file: transcript,
    legacy: session
  }
}

function reconcile(candidates: ParsedCursorCandidate[]) {
  const issues: Parameters<typeof reconcileCursorCandidates>[0]['issues'] = []
  return {
    ...reconcileCursorCandidates({
      candidates,
      executionHostId: 'local',
      platform: 'linux',
      issues
    }),
    issues
  }
}

describe('reconcileCursorCandidates', () => {
  it('merges one unambiguous sidecar and transcript field by field', () => {
    const sidecarCandidate = sidecar()
    const legacyCandidate = legacy()
    const result = reconcile([sidecarCandidate, legacyCandidate])

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: 'local:cursor:session',
      title: 'Sidecar title',
      cwd: '/repo',
      branch: 'feature',
      filePath: sidecarCandidate.file.path,
      transcriptFilePath: legacyCandidate.file.path,
      messageCount: 2,
      hasConversation: true,
      previewMessages: [{ role: 'user', text: 'hello', timestamp: null }]
    })
    expect(result.stats.reconciledCounterparts).toBe(1)
  })

  it('keeps native and WSL copies separate', () => {
    const result = reconcile([
      sidecar({ context: 'native' }),
      sidecar({ context: 'wsl:Ubuntu' }),
      sidecar({ context: 'wsl:Debian' })
    ])
    expect(result.sessions).toHaveLength(3)
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(3)
  })

  it('separates bucket collisions and leaves legacy evidence ambiguous', () => {
    const scoped = sidecar({ bucket: '11111111111111111111111111111111' })
    scoped.cwdEvidence = {
      kind: 'scope-bucket',
      cwd: '/repo',
      bucket: '11111111111111111111111111111111'
    }
    const result = reconcile([
      scoped,
      sidecar({ bucket: '22222222222222222222222222222222' }),
      legacy()
    ])
    expect(result.sessions).toHaveLength(3)
    expect(result.sessions.filter((session) => session.cwd !== null)).toHaveLength(2)
    expect(result.sessions.find((session) => session.filePath.endsWith('.jsonl'))).toMatchObject({
      cwd: null,
      transcriptFilePath: expect.stringContaining('.jsonl')
    })
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('multiple storage buckets'),
        expect.stringContaining('ambiguous storage bucket')
      ])
    )
    const scopedSession = result.sessions.find((session) => session.filePath === scoped.file.path)
    expect(scopedSession).toBeDefined()
    expect(result.scopedSessionIds).toEqual(new Set([scopedSession?.id]))
  })

  it('suppresses subagents and drops false-only groups while legacy content revives false', () => {
    expect(reconcile([sidecar({ subagent: true }), legacy()]).sessions).toEqual([])
    expect(reconcile([sidecar({ conversation: false })]).sessions).toEqual([])
    expect(reconcile([sidecar({ conversation: false }), legacy()]).sessions).toHaveLength(1)
  })

  it('never promotes weak legacy scope evidence into public cwd', () => {
    const candidate = legacy()
    candidate.cwdEvidence = { kind: 'legacy-scope-only', cwd: null }
    expect(reconcile([candidate]).sessions[0]?.cwd).toBeNull()
  })
})
