import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH } from '../../../shared/__fixtures__/layout-owner-written-session-golden-paths'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { emptyTerminalSessionProfile, openTopologyStore } from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'a switch-off build loading the session a layout-owner build wrote (downgrade probe, L8)',
  () => {
    it('hands the window the session exactly as written', async () => {
      const golden: WorkspaceSessionState = JSON.parse(
        readFileSync(LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH, 'utf8')
      )
      const directory = mkdtempSync(join(tmpdir(), 'orca-layout-owner-downgrade-'))
      directories.push(directory)
      const profile = { ...JSON.parse(emptyTerminalSessionProfile()), workspaceSession: golden }

      const store = await openTopologyStore(directory, JSON.stringify(profile))

      expect(stableJson(store.getWorkspaceSession())).toBe(stableJson(golden))
      await store.freezeWritesAsync()
    })
  }
)
