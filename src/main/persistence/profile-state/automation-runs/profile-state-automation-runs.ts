import type Database from '../../../sqlite/sync-database'
import { markAutomationRunsDocumentStorage } from './profile-state-automation-runs-storage'
import { PROFILE_STATE_AUTOMATION_RUNS_TABLE } from './profile-state-automation-runs-model'

import './profile-state-automation-runs-writer'
import './profile-state-automation-runs-reader'

export function clearProfileStateAutomationRuns(db: Database.Database): void {
  db.prepare(`DELETE FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE}`).run()
  markAutomationRunsDocumentStorage(db)
}
