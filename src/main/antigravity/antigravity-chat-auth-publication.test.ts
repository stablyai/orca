import { expect, it, vi } from 'vitest'
import {
  fixture,
  withReopenedProfileStore
} from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'
import { structuredAgentHostLaunchSources } from '../runtime/agent-session/launch/structured-agent-launch-support'
import * as profileStorage from '../orca-profiles/profile-storage-paths'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import {
  applyAntigravityChatAuthConfig,
  readAntigravityChatAuthConfig
} from './antigravity-chat-auth-settings'

const enterprise = {
  method: 'oauth-business',
  gcpProject: 'enterprise-project',
  gcpLocation: 'us-central1'
} as const

type Profile = Awaited<ReturnType<typeof fixture>>

function failWriteIndeterminately(authority: Profile['authority']) {
  const error = new ProfileStateWriterError(
    'profile-state-write-indeterminate',
    'Writer lost',
    'indeterminate'
  )
  let faulted = false
  vi.spyOn(authority, 'assertWritable').mockImplementation(() => {
    if (faulted) {
      throw error
    }
  })
  const fail = async () => {
    faulted = true
    throw error
  }
  vi.spyOn(authority, 'writeSerializedDomains').mockImplementation(fail)
  vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementation(fail)
  return error
}

async function launchFrom(store: Profile['store']) {
  const path = store.getSettings().workspaceDir
  vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(path)
  const sources = await structuredAgentHostLaunchSources(
    'antigravity',
    {
      requireStore: () => store,
      resolveStructuredAgentAccountHome: async () => ({ variable: 'GEMINI_HOME', path })
    },
    new AbortController().signal
  )
  return resolveAcpLaunchInvocation(ANTIGRAVITY_LAUNCH_SPEC, sources.accountHome, {
    resolveEnvironment: async () => sources.env,
    resolveCommandSettings: () => sources.commandSettings,
    dataDirectory: sources.dataDirectory
  })
}

it('restores only the live predecessor after an indeterminate write and never acknowledges the failed choice', async () => {
  const { store, authority, readState } = await fixture()
  const failure = failWriteIndeterminately(authority)
  try {
    await expect(applyAntigravityChatAuthConfig(store, enterprise, async () => {})).rejects.toBe(
      failure
    )
    expect(store.getSettings().antigravityChatAuth).toBeUndefined()
    expect(readState().settings.antigravityChatAuth).toBeUndefined()
    store.updateSettings({ terminalFontSize: 21 })
    expect(readAntigravityChatAuthConfig(store)).toEqual({ method: 'oauth-personal' })
    expect(store.getSettings().terminalFontSize).toBe(21)
    await expect(launchFrom(store)).resolves.toMatchObject({
      antigravityChatAuth: { method: 'oauth-personal' }
    })
    await expect(applyAntigravityChatAuthConfig(store, enterprise, async () => {})).rejects.toBe(
      failure
    )
    expect(readAntigravityChatAuthConfig(store)).toEqual({ method: 'oauth-personal' })
  } finally {
    vi.restoreAllMocks()
  }
})

it('keeps confirmed auth usable through unrelated active or faulted writes and rejected-before-mutation changes', async () => {
  const { store, authority, readState } = await fixture()
  await applyAntigravityChatAuthConfig(store, enterprise, async () => {})
  const active = authority.pause()
  const pending = store.updateSettingsAndFlush({ terminalFontSize: 21 })
  await active.started.promise
  try {
    expect(readAntigravityChatAuthConfig(store)).toEqual(enterprise)
    await expect(launchFrom(store)).resolves.toMatchObject({ antigravityChatAuth: enterprise })
  } finally {
    active.finish.resolve()
    await pending
  }
  const error = failWriteIndeterminately(authority)
  try {
    await expect(store.updateSettingsAndFlush({ terminalFontSize: 22 })).rejects.toBe(error)
    const stopped = vi.fn(async () => {})
    await expect(applyAntigravityChatAuthConfig(store, enterprise, stopped)).resolves.toEqual(
      enterprise
    )
    expect(stopped).not.toHaveBeenCalled()
    await expect(
      applyAntigravityChatAuthConfig(store, { method: 'oauth-personal' }, stopped)
    ).rejects.toBe(error)
    expect(readAntigravityChatAuthConfig(store)).toEqual(enterprise)
    await expect(launchFrom(store)).resolves.toMatchObject({ antigravityChatAuth: enterprise })
    await withReopenedProfileStore(readState(), 'confirmed-auth.json', async (reopened) => {
      expect(readAntigravityChatAuthConfig(reopened)).toEqual(enterprise)
    })
  } finally {
    vi.restoreAllMocks()
  }
})

it('keeps a rolled-back save retryable and publishes the next successful attempt', async () => {
  const { store, authority } = await fixture()
  const failure = new ProfileStateWriterError(
    'profile-state-write-failed',
    'Disk full',
    'known-failure'
  )
  vi.spyOn(authority, 'writeSerializedDomains').mockRejectedValueOnce(failure)
  vi.spyOn(authority, 'writeCompleteSerializedDomains').mockRejectedValueOnce(failure)
  try {
    await expect(applyAntigravityChatAuthConfig(store, enterprise, async () => {})).rejects.toBe(
      failure
    )
    expect(readAntigravityChatAuthConfig(store)).toEqual({ method: 'oauth-personal' })
    await expect(launchFrom(store)).resolves.toMatchObject({
      antigravityChatAuth: { method: 'oauth-personal' }
    })
    vi.restoreAllMocks()
    await expect(
      applyAntigravityChatAuthConfig(store, enterprise, async () => {})
    ).resolves.toEqual(enterprise)
    expect(readAntigravityChatAuthConfig(store)).toEqual(enterprise)
  } finally {
    vi.restoreAllMocks()
  }
})
