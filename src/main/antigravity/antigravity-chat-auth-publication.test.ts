import { expect, it, vi } from 'vitest'
import {
  fixture,
  withReopenedProfileStore
} from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { ProfileStateWriterError } from '../persistence/profile-state/profile-state-writer-errors'
import { structuredAgentHostLaunchSources } from '../runtime/agent-session/launch/structured-agent-launch-support'
import * as profileStorage from '../orca-profiles/profile-storage-paths'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../acp/acp-launch-specs'
import { antigravitySignInFailure } from './antigravity-sign-in-failure'
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

it('refuses an uncertain Store candidate through retries and host launch until loading committed state anew', async () => {
  const { store, authority, readState } = await fixture()
  const stopped = vi.fn(async () => {})
  const error = failWriteIndeterminately(authority)
  try {
    await expect(applyAntigravityChatAuthConfig(store, enterprise, stopped)).rejects.toBe(error)
    expect(store.getSettings().antigravityChatAuth).toEqual(enterprise)
    expect(readState().settings.antigravityChatAuth).toBeUndefined()
    stopped.mockClear()
    expect(() => applyAntigravityChatAuthConfig(store, enterprise, stopped)).toThrow(
      'Restart Orca on this host'
    )
    expect(() =>
      applyAntigravityChatAuthConfig(store, { method: 'oauth-personal' }, stopped)
    ).toThrow('Restart Orca on this host')
    expect(stopped).not.toHaveBeenCalled()
    expect(() => readAntigravityChatAuthConfig(store)).toThrow('Restart Orca on this host')
    await expect(launchFrom(store)).rejects.toThrow('Restart Orca on this host')
    const previous = store.getSettings()
    store.updateSettings({ terminalFontSize: 21 })
    expect(store.getSettings()).not.toBe(previous)
    expect(() => readAntigravityChatAuthConfig(store)).toThrow('Restart Orca on this host')
    await expect(launchFrom(store)).rejects.toThrow('Restart Orca on this host')
    await withReopenedProfileStore(readState(), 'reopened-auth.json', async (reopened) => {
      expect(readAntigravityChatAuthConfig(reopened)).toEqual({ method: 'oauth-personal' })
      await expect(launchFrom(reopened)).resolves.toMatchObject({
        antigravityChatAuth: { method: 'oauth-personal' }
      })
    })
    const failure = await launchFrom(store).catch((cause: unknown) => cause)
    expect(antigravitySignInFailure(failure)).toBe(
      'Antigravity account settings could not be confirmed on this host. Restart Orca on this host, then try again.'
    )
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
