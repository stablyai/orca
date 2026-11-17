import { beforeEach, describe, expect, it, vi } from 'vitest'

type ServiceFake = {
  hasServerFiles: () => boolean
  isKnownDistro: (distro: string) => Promise<boolean>
}

const host = vi.hoisted(
  (): { acceptsNewWork: boolean; settingOn: boolean; service: ServiceFake | null } => ({
    acceptsNewWork: true,
    settingOn: false,
    service: null
  })
)
vi.mock('../wsl/host-lifecycle/wsl-host-gate', () => ({
  wslHostsAcceptNewWork: () => host.acceptsNewWork
}))
vi.mock('../wsl/host-lifecycle/wsl-host-service-instance', () => ({
  getWslHostService: () => host.service
}))

import { resolveAgentLaunchModeOnHost } from './agent-launch-mode'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'
import { wslHostChatRecovery } from './agent-launch-wsl-host-recovery'

const requestedChat = {
  mode: 'structured',
  preferred: 'structured',
  reason: 'requested',
  detail: 'Started a structured chat session, as requested.'
} as const

const UBUNTU_REPO = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo'

async function refuse(reason: 'wsl' | 'remote', workspacePath: string): Promise<unknown> {
  const runtime = {
    getStructuredAgentSessionCreateSupport: async () => ({ supported: false, reason }),
    requireStore: () => ({ getSettings: () => ({ experimentalWslHosts: host.settingOn }) })
  }
  return resolveAgentLaunchModeOnHost(runtime, requestedChat, 'repo::path', 'claude', undefined, {
    phase: 'before-effects',
    agent: 'claude',
    workspacePath
  }).then(
    () => {
      throw new Error('expected a refusal')
    },
    (error: unknown) => error
  )
}

function facts(settingOn: boolean, hostAdded: boolean) {
  return async () => ({ settingOn, hostAdded })
}

describe('WSL chat refusal recovery', () => {
  beforeEach(() => {
    host.acceptsNewWork = true
    host.settingOn = false
    host.service = {
      hasServerFiles: () => true,
      isKnownDistro: async () => false
    }
  })

  it('points a WSL folder at a WSL host for its distro when hosts can be added', async () => {
    const error = await refuse('wsl', UBUNTU_REPO)
    expect(error).toBeInstanceOf(AgentLaunchSurfaceUnavailableError)
    // Older clients match the code and message, so both stay as they were.
    expect(error).toMatchObject({
      code: 'agent_launch_surface_unavailable',
      message:
        "Claude can't open as a chat here because this workspace runs under WSL. Start it in a terminal instead.",
      data: {
        wslDistro: 'Ubuntu-24.04',
        nextSteps: [
          expect.stringMatching(
            /turn on Settings → Experimental → WSL hosts, then add Ubuntu-24\.04 as a host.*then choose “Move to Ubuntu-24\.04 host…”/
          ),
          expect.stringContaining('--surface terminal')
        ]
      }
    })
  })

  it('keeps the plain refusal while WSL hosts cannot take new work', async () => {
    host.acceptsNewWork = false
    expect(await refuse('wsl', UBUNTU_REPO)).toMatchObject({ data: undefined })
    host.acceptsNewWork = true
    host.service = {
      hasServerFiles: () => false,
      isKnownDistro: async () => false
    }
    expect(await refuse('wsl', UBUNTU_REPO)).toMatchObject({ data: undefined })
    host.service = null
    expect(await refuse('wsl', UBUNTU_REPO)).toMatchObject({ data: undefined })
  })

  it('adds no WSL host steps to other refusals', async () => {
    expect(await refuse('remote', UBUNTU_REPO)).toMatchObject({ data: undefined })
  })

  it('offers no move for a Windows drive reached through the distro', async () => {
    expect(await refuse('wsl', '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo')).toMatchObject({
      data: undefined
    })
  })

  it('says only the move once the distro is a host and the setting is on', async () => {
    host.settingOn = true
    host.service = { hasServerFiles: () => true, isKnownDistro: async () => true }
    const error = await refuse('wsl', UBUNTU_REPO)
    expect(error).toMatchObject({ data: { nextSteps: [expect.any(String), expect.any(String)] } })
    const recovery = await wslHostChatRecovery(UBUNTU_REPO, facts(true, true))
    expect(error).toMatchObject({ data: recovery })
    expect(recovery?.nextSteps[0]).toBe(
      'Chat works when the project runs on the Ubuntu-24.04 WSL host. In Orca, choose “Move to Ubuntu-24.04 host…” on the project in the sidebar, then launch the chat there.'
    )
  })

  it('skips the add for a saved host while the setting is off', async () => {
    const recovery = await wslHostChatRecovery(UBUNTU_REPO, facts(false, true))
    expect(recovery?.nextSteps[0]).toContain(
      'turn on Settings → Experimental → WSL hosts, then choose'
    )
    expect(recovery?.nextSteps[0]).not.toContain('Add WSL distro')
  })
})
