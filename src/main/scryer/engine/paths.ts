import { join, resolve } from 'path'

export type ScryerPaths = {
  projectRoot: string
  scryerDir: string
  modelPath: string
  plannedPath: string
  lockPath: string
  historyPath: string
  baselinePath: string
  leasePath: string
  syncPath: string
  anchorBaselinePath: string
  anchorsPath: string
  buildEdgesPath: string
}

export function scryerPaths(projectRoot: string): ScryerPaths {
  const resolved = resolve(projectRoot)
  const scryerDir = join(resolved, '.scryer')
  return {
    projectRoot: resolved,
    scryerDir,
    modelPath: join(scryerDir, 'model.scry'),
    plannedPath: join(scryerDir, 'planned.scry'),
    lockPath: join(scryerDir, '.lock'),
    historyPath: join(scryerDir, 'history.jsonl'),
    baselinePath: join(scryerDir, 'model.baseline.scry'),
    leasePath: join(scryerDir, '.model-edit-lease.json'),
    syncPath: join(scryerDir, '.sync.json'),
    anchorBaselinePath: join(scryerDir, '.anchors.baseline.json'),
    anchorsPath: join(scryerDir, '.anchors.json'),
    buildEdgesPath: join(scryerDir, '.build_edges.json')
  }
}
