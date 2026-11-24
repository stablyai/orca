import { resolve } from 'node:path'
import type { Rollup } from 'vite'
import { createBootstrapFatalExitBanner } from './bootstrap-fatal-exit-banner'
import {
  createInheritedOrcaIdentityDropBanner,
  HOST_ENTRY_FILE_NAMES
} from './inherited-orca-identity-banner'
import { MAIN_BUILD_ENTRY_POINTS } from './main-build-entry-points'

// postBanner lands after minification and Rolldown shifts index.js.map past it, keeping crash traces on the right line.
export function createMainEntryPostBanner(
  chunk: Rollup.RenderedChunk,
  startupDiagnosticsBanner: (chunkName: string) => string
): string {
  const identityDrop = HOST_ENTRY_FILE_NAMES.has(chunk.fileName)
    ? createInheritedOrcaIdentityDropBanner()
    : ''
  if (chunk.fileName !== 'index.js') {
    return identityDrop
  }
  if (!chunk.moduleIds.some((id) => resolve(id) === MAIN_BUILD_ENTRY_POINTS.index)) {
    throw new Error('Main startup must stay in index.js so __dirname resolves app assets')
  }
  // Source guards run after Rollup’s require prelude, too late to handle missing bootstrap dependencies.
  return identityDrop + createBootstrapFatalExitBanner() + startupDiagnosticsBanner(chunk.fileName)
}
