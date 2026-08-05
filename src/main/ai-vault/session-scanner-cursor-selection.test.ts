import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  buildCursorCandidateSelectionGroups,
  canStopCursorGroupSelection,
  selectCursorScopedGroups
} from './session-scanner-cursor-selection'
import type { CursorCwdEvidence, CursorLayout, FileWithMtime } from './session-scanner-types'

type Candidate = {
  context: string
  evidence?: CursorCwdEvidence
  file: FileWithMtime
  layout: CursorLayout
}

const adapter = {
  getCwdEvidence: (candidate: Candidate) => candidate.evidence,
  getFile: (candidate: Candidate) => candidate.file,
  getLayout: (candidate: Candidate) => candidate.layout,
  getStorageContextKey: (candidate: Candidate) => candidate.context
}

function candidate(
  path: string,
  layout: CursorLayout,
  mtimeMs: number,
  cursorStoreMtimeMs?: number
): Candidate {
  return {
    context: 'native',
    file: {
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString(),
      cursorStoreMtimeMs
    },
    layout
  }
}

describe('Cursor candidate selection', () => {
  it('completes an older legacy counterpart in the selected sidecar group', () => {
    const bucket = '11111111111111111111111111111111'
    const sidecar = candidate(`/chats/${bucket}/session/meta.json`, 'sidecar', 100)
    const unrelated = candidate('/projects/other/agent-transcripts/other/other.jsonl', 'legacy', 90)
    const legacy = candidate('/projects/repo/agent-transcripts/session/session.jsonl', 'legacy', 1)

    const groups = buildCursorCandidateSelectionGroups({
      candidates: [sidecar, unrelated, legacy],
      platform: 'linux',
      adapter
    })

    expect(groups).toHaveLength(2)
    expect(groups[0]?.candidates).toEqual([sidecar, legacy])
    expect(groups[1]?.candidates).toEqual([unrelated])
  })

  it('keeps bucket collisions together but ambiguous legacy paths independent', () => {
    const first = candidate(
      '/chats/11111111111111111111111111111111/session/meta.json',
      'sidecar',
      100
    )
    const second = candidate(
      '/chats/22222222222222222222222222222222/session/meta.json',
      'sidecar',
      90
    )
    const legacy = candidate('/projects/repo/agent-transcripts/session/session.jsonl', 'legacy', 80)

    const groups = buildCursorCandidateSelectionGroups({
      candidates: [first, second, legacy],
      platform: 'linux',
      adapter
    })

    expect(groups).toHaveLength(2)
    expect(groups[0]?.candidates).toEqual([first, second])
    expect(groups[1]?.candidates).toEqual([legacy])
  })

  it('selects scoped keys after the normal recency cutoff', () => {
    const visible = {
      updatedAt: '2026-07-01T00:00:00.000Z',
      modifiedAt: '2026-07-01T00:00:00.000Z'
    } as AiVaultSession
    expect(canStopCursorGroupSelection([visible], 1, Date.parse('2026-06-01'))).toBe(true)
    expect(canStopCursorGroupSelection([visible], 2, Date.parse('2026-06-01'))).toBe(false)
  })

  it('prioritizes scope buckets over weak legacy matches before truncation', () => {
    const strong = candidate(
      '/chats/11111111111111111111111111111111/strong/meta.json',
      'sidecar',
      1
    )
    strong.evidence = {
      kind: 'scope-bucket',
      cwd: '/repo',
      bucket: '11111111111111111111111111111111'
    }
    const weak = candidate('/projects/repo/agent-transcripts/weak/weak.jsonl', 'legacy', 100)
    weak.evidence = { kind: 'legacy-scope-only', cwd: null }
    const groups = buildCursorCandidateSelectionGroups({
      candidates: [weak, strong],
      platform: 'linux',
      adapter
    })

    expect(selectCursorScopedGroups(groups, new Set(), 1)[0]?.candidates).toEqual([strong])
  })

  it('ranks sidecars by the latest metadata or store activity', () => {
    const activeStore = candidate(
      '/chats/11111111111111111111111111111111/active/meta.json',
      'sidecar',
      1,
      200
    )
    const newerMetadata = candidate(
      '/chats/22222222222222222222222222222222/metadata/meta.json',
      'sidecar',
      100,
      50
    )

    const groups = buildCursorCandidateSelectionGroups({
      candidates: [newerMetadata, activeStore],
      platform: 'linux',
      adapter
    })

    expect(groups.map((group) => group.candidates[0])).toEqual([activeStore, newerMetadata])
  })
})
