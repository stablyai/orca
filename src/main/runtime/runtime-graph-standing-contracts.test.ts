import { registerHeadlessRuntimeGraphTests } from './headless-runtime-graph.spec'
import { registerHeadlessPlaceholderGraphSurfaceStandingTests } from './headless-placeholder-graph-surface-standing.spec'
import { registerTerminalListSurfaceLostOrphanTests } from './terminal-list-surface-lost-orphan.spec'
import { registerTerminalListStaleLeafLivenessTests } from './terminal-list-stale-leaf-liveness.spec'

registerHeadlessRuntimeGraphTests()
registerHeadlessPlaceholderGraphSurfaceStandingTests()
registerTerminalListSurfaceLostOrphanTests()
registerTerminalListStaleLeafLivenessTests()
