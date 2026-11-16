import { beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({ acceptsNewWork: true }))
vi.mock('../wsl/host-lifecycle/wsl-host-gate', () => ({
  wslHostsAcceptNewWork: () => gate.acceptsNewWork
}))

import { downgradeAgentLaunchModeForHost } from './agent-launch-mode'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'
import { wslHostChatRecovery } from './agent-launch-wsl-host-recovery'

const requestedChat = {
  mode: 'structured',
  preferred: 'structured',
  reason: 'requested',
  detail: 'Started a structured chat session, as requested.'
} as const

function refuse(reason: 'wsl' | 'remote', workspacePath: string): unknown {
  try {
    downgradeAgentLaunchModeForHost(requestedChat, { supported: false, reason }, undefined, {
      phase: 'before-effects',
      agent: 'claude',
      workspacePath
    })
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

describe('WSL chat refusal recovery', () => {
  beforeEach(() => {
    gate.acceptsNewWork = true
  })

  it('points a WSL folder at a WSL host for its distro when hosts can be added', () => {
    const error = refuse('wsl', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo')
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
            /Settings → Experimental → WSL hosts.*add Ubuntu-24\.04 as a host.*“Move to Ubuntu-24\.04 host…”/
          ),
          expect.stringContaining('--surface terminal')
        ]
      }
    })
  })

  it('keeps the plain refusal while WSL hosts cannot take new work', () => {
    gate.acceptsNewWork = false
    const error = refuse('wsl', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    expect(error).toBeInstanceOf(AgentLaunchSurfaceUnavailableError)
    expect(error).toMatchObject({ data: undefined })
  })

  it('adds no WSL host steps to other refusals', () => {
    const error = refuse('remote', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    expect(error).toMatchObject({ data: undefined })
  })

  it('names no distro when the path does not carry one', () => {
    const recovery = wslHostChatRecovery(undefined, () => true)
    expect(recovery?.wslDistro).toBeUndefined()
    expect(recovery?.nextSteps[0]).toContain('add the distro as a host')
  })
})
