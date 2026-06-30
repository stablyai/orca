import type { C4ModelData, DriftReport } from '../../shared/scryer/model-types'
import { serializeModelForPrompt, syncPrompt } from '../../shared/scryer/prompts'
import { checkDrift } from './drift'
import {
  clearPreSyncSnapshot,
  markSynced,
  readModel,
  readPreSyncSnapshot,
  setImplementing,
  writeModel,
  writePreSyncSnapshot
} from './model-store'

export type BeginSyncResult = {
  prompt: string
  drift: DriftReport
  snapshot: C4ModelData
}

export async function beginSync(
  projectPath: string,
  options?: { modelName?: string }
): Promise<BeginSyncResult> {
  const [model, drift] = await Promise.all([readModel(projectPath), checkDrift(projectPath)])
  await writePreSyncSnapshot(projectPath, model)
  await setImplementing(projectPath, true)
  return {
    prompt: syncPrompt({
      modelName: options?.modelName ?? 'Architecture',
      cwd: projectPath,
      drift,
      modelJson: serializeModelForPrompt(model)
    }),
    drift,
    snapshot: model
  }
}

export async function cancelSync(projectPath: string): Promise<C4ModelData> {
  const snapshot = await readPreSyncSnapshot(projectPath)
  if (!snapshot) {
    await setImplementing(projectPath, false)
    throw new Error('No pre-sync architecture snapshot found.')
  }
  await writeModel(projectPath, snapshot)
  await clearPreSyncSnapshot(projectPath)
  await setImplementing(projectPath, false)
  return snapshot
}

export async function finishSync(projectPath: string): Promise<void> {
  await markSynced(projectPath)
  await clearPreSyncSnapshot(projectPath)
  await setImplementing(projectPath, false)
}
