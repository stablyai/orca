import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedState } from '../../shared/persisted-state-types'
import { Store } from '../persistence/loading-store/store'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  getOrcaProfileDataFile,
  getOrcaProfileIndexPath
} from '../orca-profiles/profile-storage-paths'

type RestoredWorkerInput = {
  directory: string
  runtimeId: string
  handle: string
  workspaceKey: string
  tabId: string
  leafId: string
  terminalId: string
  incarnationId: string
}

function existingProfileDataFile(directory: string): string {
  const userData = join(directory, 'data')
  const index = JSON.parse(readFileSync(getOrcaProfileIndexPath(userData), 'utf8'))
  if (
    typeof index.activeProfileId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(index.activeProfileId)
  ) {
    throw new Error('fixture_active_profile_invalid')
  }
  return getOrcaProfileDataFile(index.activeProfileId, userData)
}

export function readLiveOrcadSleepingWorker(directory: string, paneKey: string) {
  const state = JSON.parse(
    readFileSync(existingProfileDataFile(directory), 'utf8')
  ) as PersistedState
  return state.workspaceSession.sleepingAgentSessionsByPaneKey?.[paneKey]
}

// Only call between fixture stop and restart; neither profile writer may overlap the daemon.
export async function seedLiveOrcadRestoredWorker(input: RestoredWorkerInput) {
  const profileDirectory = join(input.directory, 'data')
  const dataFile = existingProfileDataFile(input.directory)
  // Refuse a mistyped fixture path instead of silently creating a fresh profile.
  JSON.parse(readFileSync(dataFile, 'utf8'))
  const store = new Store({ dataFile, storageAuthority: 'runtime' })
  const db = new OrchestrationDb(join(profileDirectory, 'orchestration.db'))
  const paneKey = `${input.tabId}:${input.leafId}`
  const processIncarnation = `${input.terminalId}:${input.incarnationId}`
  try {
    const task = db.createTask({ spec: 'Preserve the captured worker through source outage' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' },
      runtimeEpoch: input.runtimeId
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: input.handle,
      paneKey,
      processIncarnation,
      worktreeId: input.workspaceKey,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    const session = store.getWorkspaceSession('local')
    store.setWorkspaceSession(
      {
        ...session,
        sleepingAgentSessionsByPaneKey: {
          ...session.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            paneKey,
            tabId: input.tabId,
            worktreeId: input.workspaceKey,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'captured-worker-fixture' },
            prompt: '',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        }
      },
      'local'
    )
    await store.flushPendingOrThrowAsync()
    return { taskId: task.id, dispatchId: started.dispatch.id, paneKey, processIncarnation }
  } finally {
    store.freezeWrites()
    db.close()
  }
}
