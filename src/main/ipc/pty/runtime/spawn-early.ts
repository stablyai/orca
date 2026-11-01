import type { RuntimePtySpawnState } from './spawn-state'
import { requireAcceptedSpawn } from '../spawn-outcome'
import { beginPtySpawn, reportPtyPaneAdoption } from '../spawn-begin'

/** Host reply projection only; acquisition and process lifetime belong to the pane operation. */
export async function adoptMaterializedRuntimePtySpawn(ctx: RuntimePtySpawnState) {
  const adopted = ctx.args.adoptedStablePane
  if (!adopted?.materialized) {
    return null
  }
  ctx.preAdoptedStablePane = adopted
  await beginPtySpawn(ctx)
  requireAcceptedSpawn(adopted.outcome ?? { kind: 'adopted', result: adopted.result })
  const handle = adopted.owner.handle ?? ctx.args.preAllocatedHandle
  if (!handle) {
    throw new Error('terminal_pane_owner_unknown')
  }
  reportPtyPaneAdoption(ctx, adopted)
  return {
    ...adopted.result,
    stablePaneOwner: { handle, tabId: adopted.owner.tabId, leafId: adopted.owner.leafId }
  }
}
