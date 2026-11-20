import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type * as HostAcp from '../../antigravity/antigravity-host-acp'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './chat/structured-session-account-home'

const hostEnvironment = vi.hoisted(() => vi.fn(async () => ({ PATH: '', HOME: '/nowhere' })))
vi.mock('./chat/structured-session-cli-writer-host', () => ({
  OrcaRuntimeWithStructuredSessionCliWriterHost: class {}
}))
vi.mock('../../orca-profiles/profile-storage-paths', async () => {
  const { tmpdir } = await import('node:os')
  return { getProfileUserDataPath: () => tmpdir() }
})
vi.mock('../agent-session/launch/structured-agent-launch-support', () => ({
  resolveHostStructuredAgentLaunchEnvironment: hostEnvironment
}))
vi.mock('../../antigravity/antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  hasAgyCredential: async () => true,
  antigravityHostAcpReady: async () => true
}))

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

abstract class AccountHomeRuntime extends OrcaRuntimeWithStructuredSessionAccountHome {
  resolveCreateHome(workspaceId: string) {
    const record = agentSessionRecordFixture()
    return this.structuredAgentAccountHomeResolver(
      'antigravity',
      '',
      'launch'
    )?.({ launchEnv: {}, location: { ...record.location, workspaceId } })
  }
}

it.skipIf(process.platform === 'win32')(
  "starts a managed agent's Antigravity chat on the host's signed-in agy, as other chats do",
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
    const bin = mkdtempSync(join(tmpdir(), 'agy-bin-'))
    folders.push(home, bin)
    writeFileSync(join(bin, 'agy'), '#!/bin/sh\n')
    chmodSync(join(bin, 'agy'), 0o755)
    hostEnvironment.mockResolvedValue({ PATH: bin, HOME: home })
    const managedAgent = { folderWorkspaceId: 'zorblax-home' }
    const runtime: AccountHomeRuntime = Object.assign(Object.create(AccountHomeRuntime.prototype), {
      accounts: {},
      requireStore: () => ({ getSettings: () => ({}), getBots: () => [managedAgent] }),
      structuredAgentLaunchEnv: () => ({})
    })

    await expect(
      runtime.resolveCreateHome(folderWorkspaceKey(managedAgent.folderWorkspaceId))
    ).resolves.toEqual({ variable: 'GEMINI_HOME', path: join(home, '.gemini') })
  }
)
