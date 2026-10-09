import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

// cross-version-session-tabs-editor-mirror runs a current host's editor publication, mirror apply,
// and persisted marker against a released peer, so those modules must start that job.
describe('cross-version wire routing for editor mirror publication', () => {
  it.each([
    'src/renderer/src/runtime/sync-runtime-graph/mobile-session-surfaces.ts',
    'src/renderer/src/runtime/web-session-tabs-sync/snapshot-api.ts',
    'src/shared/workspace-session-editor-schema.ts',
    'src/shared/workspace-session-salvage.ts'
  ])('runs the cross-version suites when %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': true })
  })
})
