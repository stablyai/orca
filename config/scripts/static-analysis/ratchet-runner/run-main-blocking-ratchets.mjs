import { readEventLoopSources } from '../process-boundaries/main-blocking-import-graph.mjs'
import { main as checkMainBlockingApi } from '../ratchets/runtime-lifecycle/check-main-blocking-api-ratchet.mjs'
import { main as checkMainBlockingHelper } from '../ratchets/runtime-lifecycle/check-main-blocking-helper-ratchet.mjs'
import { main as checkMainSyncFs } from '../ratchets/runtime-lifecycle/check-main-sync-fs-ratchet.mjs'

const root = process.cwd()
const sources = await readEventLoopSources(root)
for (const check of [checkMainSyncFs, checkMainBlockingApi, checkMainBlockingHelper]) {
  if (await check(root, undefined, sources)) {
    process.exitCode = 1
  }
}
