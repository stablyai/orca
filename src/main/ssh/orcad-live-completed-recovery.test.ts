import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import { createOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'
import { validateOrcadLiveCompletedRecovery } from './orcad-live-completed-recovery'
import { OrcadLiveSourceRouteCheckpointStore } from './orcad-live-source-route-checkpoint'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-completed-recovery-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it.each(['folder', 'worktree'] as const)(
  'validates completed %s evidence and refuses its missing route checkpoint',
  (kind) => {
    const f = liveSourceCompletionEvidenceFixture(root, kind)
    f.persist()
    const completionEvidence = readOrcadLiveSourceCompletionEvidence(root, f.committed)
    const completed = createOrcadLiveCompletedCutover({
      committed: f.committed,
      completionEvidence,
      retiredAt: '2026-09-07T12:00:00.000Z'
    })
    expect(validateOrcadLiveCompletedRecovery(root, completed)).toEqual({
      record: f.record,
      completed
    })
    const changed = {
      ...completed,
      sourceCompletion: { ...completionEvidence, sourceRouteCheckpointSha256: 'f'.repeat(64) }
    }
    expect(() => validateOrcadLiveCompletedRecovery(root, changed)).toThrow('successor_mismatch')
    vi.spyOn(OrcadLiveSourceRouteCheckpointStore.prototype, 'list').mockReturnValue([])
    expect(() => validateOrcadLiveCompletedRecovery(root, completed)).toThrow('checkpoint_required')
  }
)
