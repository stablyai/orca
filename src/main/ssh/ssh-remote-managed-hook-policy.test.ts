import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setManagedHookInstallDecisionResolver } from '../agent-hooks/managed-hook-install-policy'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const { SshRelaySession } = await import('./ssh-relay-session')

/**
 * These install into the REMOTE host's user-global agent configs, so they are a writer in their
 * own right — `installManagedAgentHooks` is never on this path. Driven through the prototype
 * because both methods are private and constructing a full session needs a live SSH connection.
 */
type RemoteHookSession = {
  store: { getSettings: () => Partial<GlobalSettings> }
  targetId: string
  remoteCliBridgeEnv: undefined
  installManagedHooksOnRemote: (mux: SshChannelMultiplexer) => Promise<void>
  installPluginsOnRelay: (mux: SshChannelMultiplexer) => Promise<void>
}

function createSession(settings: Partial<GlobalSettings>): RemoteHookSession {
  const session = Object.create(SshRelaySession.prototype) as RemoteHookSession
  session.store = { getSettings: () => settings }
  session.targetId = 'ssh:test-host'
  session.remoteCliBridgeEnv = undefined
  return session
}

let request: ReturnType<typeof vi.fn>
let mux: SshChannelMultiplexer

beforeEach(() => {
  request = vi.fn(async () => ({ agents: [] }))
  mux = { request, isDisposed: () => false } as unknown as SshChannelMultiplexer
  process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
  setManagedHookInstallDecisionResolver(null)
})

afterEach(() => {
  delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
  setManagedHookInstallDecisionResolver(null)
})

describe('SSH remote managed hook install authorization', () => {
  it('asks the remote host nothing while the first-run question is unanswered', async () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))

    await createSession({}).installManagedHooksOnRemote(mux)

    expect(request).not.toHaveBeenCalled()
  })

  it('asks the remote host nothing when hooks are turned off', async () => {
    await createSession({ agentStatusHooksEnabled: false }).installManagedHooksOnRemote(mux)

    expect(request).not.toHaveBeenCalled()
  })

  it('detects remote agents for an installation that is not deferring', async () => {
    await createSession({}).installManagedHooksOnRemote(mux)

    expect(request).toHaveBeenCalledWith('preflight.detectAgents', expect.anything())
  })

  it('ships no plugin overlay to the remote while deferred either', async () => {
    setManagedHookInstallDecisionResolver(() => ({ kind: 'defer', reason: 'onboarding-pending' }))

    await createSession({}).installPluginsOnRelay(mux)

    expect(request).not.toHaveBeenCalled()
  })
})
