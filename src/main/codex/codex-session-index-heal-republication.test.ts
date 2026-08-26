import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPendingHealThreads } from './codex-session-index-heal-state'

const threadId = '11111111-1111-1111-1111-111111111111'

function target(root: string): string {
  return join(root, '2026', '07', '01', `rollout-2026-07-01T10-00-00-${threadId}.jsonl`)
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-heal-republication-'))
  return {
    auditLogPath: join(dir, 'audit.jsonl'),
    healLedgerPath: join(dir, 'heal.jsonl'),
    healMarkerPath: join(dir, 'marker.json'),
    systemSessionsRoot: join(dir, 'system', 'sessions')
  }
}

describe('Codex session index heal republication identity', () => {
  it.each(['healed', 'missing'] as const)(
    'keeps a same-path %s outcome when the file instance is unchanged',
    (outcome) => {
      const rig = paths()
      const file = target(rig.systemSessionsRoot)
      writeFileSync(
        rig.auditLogPath,
        `${JSON.stringify({ action: 'existing', target: file, fileInstanceId: 'same-instance', fileEventId: 'same-event' })}\n`
      )
      writeFileSync(
        rig.healLedgerPath,
        `${JSON.stringify({ v: 4, systemSessionsRoot: rig.systemSessionsRoot, threadId, outcome, targetPath: file, fileInstanceId: 'same-instance', fileEventId: 'same-event' })}\n`
      )

      expect(collectPendingHealThreads(rig)).toEqual([])
    }
  )

  it('retries a missing same-path rollout after its contents grow', () => {
    const rig = paths()
    const file = target(rig.systemSessionsRoot)
    writeFileSync(
      rig.auditLogPath,
      `${JSON.stringify({ action: 'existing', target: file, fileInstanceId: 'same-instance', fileEventId: 'new-event' })}\n`
    )
    writeFileSync(
      rig.healLedgerPath,
      `${JSON.stringify({ v: 4, systemSessionsRoot: rig.systemSessionsRoot, threadId, outcome: 'missing', targetPath: file, fileInstanceId: 'same-instance', fileEventId: 'old-event' })}\n`
    )

    expect(collectPendingHealThreads(rig)).toMatchObject([{ threadId, fileEventId: 'new-event' }])
  })

  it.each(['healed', 'missing'] as const)(
    'requeues a same-path publication after a %s file instance changes',
    (outcome) => {
      const rig = paths()
      const file = target(rig.systemSessionsRoot)
      writeFileSync(
        rig.auditLogPath,
        `${JSON.stringify({ action: 'existing', target: file, recordId: 'new-record', fileInstanceId: 'new-instance', fileEventId: 'new-event' })}\n`
      )
      writeFileSync(
        rig.healLedgerPath,
        `${JSON.stringify({ v: 4, systemSessionsRoot: rig.systemSessionsRoot, threadId, outcome, targetPath: file, fileInstanceId: 'old-instance', fileEventId: 'old-event' })}\n`
      )

      expect(collectPendingHealThreads(rig)).toMatchObject([
        { threadId, targetPath: file, fileInstanceId: 'new-instance' }
      ])
    }
  )
})
