import type { OrchestrationDb } from '../orchestration-db'

export function getRunCollaborationTopology(
  this: OrchestrationDb,
  runId: string
): string | undefined {
  const row = this.db
    .prepare('SELECT topology FROM run_collaboration_topologies WHERE run_id = ?')
    .get(runId) as { topology: string } | undefined
  return row?.topology
}

export function setRunCollaborationTopology(
  this: OrchestrationDb,
  runId: string,
  serializedTopology: string
): void {
  this.requireRun(runId)
  const result = this.db
    .prepare(
      `INSERT OR IGNORE INTO run_collaboration_topologies (run_id, topology)
       VALUES (?, ?)`
    )
    .run(runId, serializedTopology)
  if (result.changes === 1) {
    return
  }
  throw new Error(`collaboration run ${runId} is already registered`)
}

export function clearRunCollaborationTopology(this: OrchestrationDb, runId: string): void {
  this.db.prepare('DELETE FROM run_collaboration_topologies WHERE run_id = ?').run(runId)
}

export type RunCollaborationTopologyMethods = {
  getRunCollaborationTopology: typeof getRunCollaborationTopology
  setRunCollaborationTopology: typeof setRunCollaborationTopology
  clearRunCollaborationTopology: typeof clearRunCollaborationTopology
}

export function attachRunCollaborationTopology(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getRunCollaborationTopology,
    setRunCollaborationTopology,
    clearRunCollaborationTopology
  })
}
