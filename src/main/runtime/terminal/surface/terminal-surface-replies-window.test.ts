import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import {
  captureSurfaceReplies,
  mountedSurfaceGraph,
  recordedSurfaceReplies,
  surfaceRuntime
} from './terminal-surface-replies.test-fixture'

// The recorded reference is the window-owned build's, whatever switch the suite runs with.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const golden = (name: string): string => path.join(__dirname, '__fixtures__', name)

function expectRecorded(replies: string, name: string): void {
  if (process.env.ORCA_RECORD_SURFACE_REPLIES === '1') {
    writeFileSync(golden(name), `${JSON.stringify(JSON.parse(replies), null, 2)}\n`)
  }
  expect(replies).toBe(recordedSurfaceReplies(golden(name)))
}

// The window-owned build's replies: the reference a layout-owner build must match byte for byte.
describe('terminal replies today (switch off)', () => {
  it('from a desktop window that mounts both panes', async () => {
    const { runtime } = surfaceRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, mountedSurfaceGraph())
    expectRecorded(await captureSurfaceReplies(runtime), 'terminal-surface-replies-desktop.json')
  })

  it('from a server with no window', async () => {
    const { runtime } = surfaceRuntime()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    expectRecorded(await captureSurfaceReplies(runtime), 'terminal-surface-replies-headless.json')
  })
})
