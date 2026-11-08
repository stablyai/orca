import { registerHeadlessRuntimeGraphTests } from './headless-runtime-graph.spec'
import { registerHeadlessPlaceholderGraphSurfaceStandingTests } from '../terminal/surface/headless-placeholder-graph-surface-standing.spec'
import { registerTerminalListSurfaceLostOrphanTests } from '../terminal/surface/terminal-list-surface-lost-orphan.spec'

registerHeadlessRuntimeGraphTests()
registerHeadlessPlaceholderGraphSurfaceStandingTests()
registerTerminalListSurfaceLostOrphanTests()
