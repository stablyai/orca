import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db'
import { SessionLinkStore } from './session-link-store'
import { pauseSessionLinkForSession } from './session-link-lifecycle'
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
it('keeps session forgetting best effort when the link store cannot be read', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(SessionLinkStore.prototype, 'forSession').mockImplementation(() => {
      throw new Error('Link store unavailable')
    })
    expect(() => pauseSessionLinkForSession(db, 'codex_work')).not.toThrow()
  } finally {
    db.close()
  }
})
