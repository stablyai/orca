import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
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

it("starts a bot's Antigravity chat on Orca's own server, never asking about the host's agy", async () => {
  const bot = { folderWorkspaceId: 'zorblax-home' }
  const runtime: AccountHomeRuntime = Object.assign(Object.create(AccountHomeRuntime.prototype), {
    accounts: {},
    requireStore: () => ({ getSettings: () => ({}), getBots: () => [bot] }),
    structuredAgentLaunchEnv: () => ({})
  })
  const managed = { variable: 'GEMINI_HOME', path: join(tmpdir(), 'antigravity-chat') }

  await expect(
    runtime.resolveCreateHome(folderWorkspaceKey(bot.folderWorkspaceId))
  ).resolves.toEqual(managed)
  expect(hostEnvironment).not.toHaveBeenCalled()
})
