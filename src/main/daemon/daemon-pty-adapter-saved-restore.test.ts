import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonServer } from './daemon-server'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const ARMED_ENV = {
  ORCA_SAVED_RESTORE_ACTION: '/actions/a/action',
  ORCA_SAVED_RESTORE_SCRIPT: '/scripts/restore',
  ORCA_SAVED_RESTORE_ORIGINAL: "claude '--resume' 'X'",
  ORCA_SAVED_RESTORE_CHECK: '/app/bin/orca',
  ORCA_SAVED_RESTORE_BUDGET_MS: '4000',
  KEEP: '1'
}

describe('a saved restore launch sent to a daemon', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let sent: Record<string, string> | undefined

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness((opts) => {
      sent = opts.env
      return createMockSubprocess()
    })
    dir = harness.dir
    server = harness.server
    adapter = harness.adapter
    sent = undefined
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('carries its startup inputs to a daemon whose hello says its shells can own the start', async () => {
    await adapter.spawn({ cols: 80, rows: 24, command: "claude '--resume' 'X'", env: ARMED_ENV })
    expect(sent).toMatchObject(ARMED_ENV)
  })

  it('sends an older daemon only the plain resume', async () => {
    await adapter.spawn({ cols: 80, rows: 24 })
    // An older daemon's hello has no such capability.
    const client = (
      adapter as unknown as { client: { supportsSavedRestorePrivateStartup: () => boolean } }
    ).client
    client.supportsSavedRestorePrivateStartup = () => false
    await adapter.spawn({ cols: 80, rows: 24, command: "claude '--resume' 'X'", env: ARMED_ENV })
    expect(sent).toEqual({ KEEP: '1' })
  })
})
