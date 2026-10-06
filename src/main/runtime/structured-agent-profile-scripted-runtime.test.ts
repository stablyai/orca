import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentProfileConnectionService } from '../agent-profiles/connection-service'
import {
  createClaudeProfileAdapter,
  createCodexProfileAdapter
} from '../agent-profiles/provider-adapters'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import type { AgentLaunchProfile } from '../../shared/agent-launch-profile'

vi.mock('../claude-accounts/claude-profile-cli', () => ({
  assertClaudeProfileCli: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/profile-home'), isPackaged: false }
}))

it('scripted Claude runtime retains snapshot ownership through exit, unlink and reacquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-scripted-'))
  const home = join(root, 'one')
  const executable = join(root, 'cli')
  await mkdir(home)
  await writeFile(executable, '#!/bin/sh\necho synthetic\n')
  await chmod(executable, 0o700)
  const release = vi.fn()
  let profiles: AgentLaunchProfile[] = []
  const callbacks = {
    inspectManaged: async () => ({
      home,
      identity: { kind: 'verified' as const, subject: 'one', displayName: 'One' }
    }),
    prepareManaged: async () => ({ home, envPatch: {}, envToDelete: [], release })
  }
  const service = new AgentProfileConnectionService({
    host: { hostId: 'local', platform: 'linux', isWsl: false, home: root, shell: '/bin/sh' },
    adapters: {
      claude: createClaudeProfileAdapter(callbacks),
      codex: createCodexProfileAdapter(callbacks)
    },
    detectExecutable: async () => executable,
    store: {
      read: () => profiles,
      write: async (next) => {
        profiles = next
      }
    }
  })
  const profile = await service.save({
    name: 'One',
    connection: { agent: 'claude', source: { kind: 'managed', accountId: 'one' } }
  })
  const snapshot = await service.resolveSnapshotById(profile.id, {
    mode: 'structured',
    resume: false
  })
  const record = {
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: home, agentProfile: snapshot }
  }
  const identity = { sessionId: 'profile_scripted' }
  const location = {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'workspace',
    workspaceKind: 'folder' as const
  }
  const runtime = createScriptedClaudeRuntime([identity.sessionId], { agentProfiles: service })
  try {
    const host = await runtime.install()
    const attach = runtime.attachParams(identity.sessionId, null, {
      location,
      accountHome: record.accountHome
    })
    const first = await host.attach({ callerKey: 'profile-test' }, attach)
    expect(first).toMatchObject({ ok: true })
    expect(runtime.child(identity.sessionId).launch.env?.CLAUDE_CONFIG_DIR).toBe(
      snapshot.resolvedHome
    )
    expect(release).toHaveBeenCalledTimes(1)
    await service.unlink(profile.id)
    runtime.child(identity.sessionId).exit(new Error('synthetic exit'))
    await waitForStructuredAgentSessionRecovery()
    const saved = host.deps.store.getRecord(identity.sessionId)!
    const next = await host.attach(
      { callerKey: 'profile-test' },
      runtime.attachParams(identity.sessionId, saved.lease.runtimeFence, {
        location,
        accountHome: saved.accountHome
      })
    )
    expect(next).toMatchObject({ ok: true })
    expect(runtime.children(identity.sessionId)).toHaveLength(2)
    expect(runtime.child(identity.sessionId).launch.env?.CLAUDE_CONFIG_DIR).toBe(
      snapshot.resolvedHome
    )
    expect(release).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
