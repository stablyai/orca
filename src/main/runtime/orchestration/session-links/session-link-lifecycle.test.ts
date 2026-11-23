import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db/orchestration-db'
import { SessionLinkStore } from './session-link-store'
import { pauseSessionLinkForSession } from './session-link-lifecycle'
import { inProcessSessionLinks } from './worker/session-link-worker.test-fixture'
class RuntimeWithRestore extends OrcaRuntimeService {
  restoreMail() {
    this.scheduleRestoredMessageRepoints()
  }
}
afterEach(() => vi.restoreAllMocks())
it('keeps existing mail recovery and forgetting available if the link database cannot open', () => {
  const runtime = new RuntimeWithRestore()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(runtime, 'getExistingOrchestrationDb').mockImplementation(() => {
    throw new Error('DB unavailable')
  })
  expect(() => runtime.notifyStructuredSessionJournalActivity('codex_work')).not.toThrow()
  expect(() => runtime.forgetStructuredSessionMail('codex_work')).not.toThrow()
  expect(() => runtime.restoreMail()).not.toThrow()
})
it('keeps session forgetting best effort when the link store cannot be read', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    inProcessSessionLinks(db)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(SessionLinkStore.prototype, 'forSession').mockImplementation(() => {
      throw new Error('Link store unavailable')
    })
    await expect(pauseSessionLinkForSession(db, 'codex_work')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[session-link] pause unavailable', expect.any(Error))
  } finally {
    db.close()
  }
})
