import { afterEach, expect, it } from 'vitest'
import type { AiVaultScanWork } from '../../shared/ai-vault/scanning/ai-vault-scan-progress'
import {
  localAiVaultScanProgress,
  resetLocalAiVaultScanProgressForTests,
  startLocalAiVaultScanProgress
} from './ai-vault-local-scan-progress'

const READING: AiVaultScanWork = {
  stage: 'reading',
  agents: [],
  read: { done: 120, total: 29_154 },
  contentReads: 3
}

afterEach(() => resetLocalAiVaultScanProgressForTests())

it('keeps the last finished scan on screen until a rescan reads more than live transcripts', () => {
  expect(localAiVaultScanProgress('scope')).toBeNull()
  const first = startLocalAiVaultScanProgress('scope', 'first', () => 1_000)
  first.work(READING)
  expect(localAiVaultScanProgress('scope')).toBeNull()
  first.work({ ...READING, contentReads: 50 })
  expect(localAiVaultScanProgress('scope')).toMatchObject({ scanId: 'first', stage: 'reading' })
  first.finish({ ...READING, contentReads: 50 })

  const rescan = startLocalAiVaultScanProgress('scope', 'rescan', () => 2_000)
  rescan.work(READING)
  expect(localAiVaultScanProgress('scope')).toMatchObject({ scanId: 'first', stage: 'finished' })
  rescan.work({ ...READING, contentReads: 50 })
  expect(localAiVaultScanProgress('scope')).toMatchObject({ scanId: 'rescan', stage: 'reading' })
  rescan.finish(READING)
  expect(localAiVaultScanProgress('scope')).toMatchObject({ scanId: 'rescan', stage: 'finished' })
})
