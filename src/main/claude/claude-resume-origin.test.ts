import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { claudeResumeOriginsEqual } from '../../shared/claude-resume-origin'
import { publishHostDescriptor } from '../runtime/host-descriptor'
import {
  resolveClaudeHookResumeOrigin,
  resolveClaudeResumeLaunchOrigin
} from './claude-resume-origin'

const runtime = { getRuntimeId: () => 'claude-origin-test' }
const row: AgentHookEventPayload = {
  paneKey: 'tab:leaf',
  worktreeId: 'workspace',
  connectionId: null,
  launchToken: 'launch',
  payload: { agentType: 'claude', state: 'working', prompt: '' }
}
const pty = {
  connected: true,
  incarnationId: 'incarnation',
  launchToken: 'launch',
  worktreeId: 'workspace',
  connectionId: null,
  isWsl: false,
  wslDistro: null
}

afterEach(() => publishHostDescriptor(runtime.getRuntimeId(), null))

describe('Claude recovery execution origin', () => {
  it('requires a published machine-bound owner, independent of hook claims', () => {
    expect(resolveClaudeHookResumeOrigin(runtime, row, pty)).toBeUndefined()
    publishHostDescriptor(runtime.getRuntimeId(), { installationId: 'installation' })
    expect(resolveClaudeHookResumeOrigin(runtime, row, pty)).toBeUndefined()
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: 'installation',
      machineBinding: 'machine'
    })
    expect(resolveClaudeHookResumeOrigin(runtime, row, pty)).toEqual({
      installationId: 'installation',
      machineBinding: 'machine',
      host: { kind: 'local' }
    })
  })

  it('rejects stale launches, missing process identity and wrong workspace or route', () => {
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: 'installation',
      machineBinding: 'machine'
    })
    for (const invalid of [
      { ...pty, connected: false },
      { ...pty, incarnationId: null },
      { ...pty, launchToken: 'replacement' },
      { ...pty, worktreeId: 'other-workspace' },
      { ...pty, connectionId: 'ssh-1' },
      { ...pty, isWsl: null }
    ]) {
      expect(resolveClaudeHookResumeOrigin(runtime, row, invalid)).toBeUndefined()
    }
    expect(
      resolveClaudeHookResumeOrigin(runtime, { ...row, connectionId: 'ssh-1' }, pty)
    ).toBeUndefined()
  })

  it('binds a WSL hook to its admitted distro and refuses default or different distros', () => {
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: 'installation',
      machineBinding: 'machine'
    })
    const wsl = { ...pty, isWsl: true, wslDistro: 'Ubuntu' }
    const captured = resolveClaudeHookResumeOrigin(
      runtime,
      { ...row, connectionId: 'wsl:Ubuntu' },
      wsl
    )
    expect(captured?.host).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(
      resolveClaudeHookResumeOrigin(runtime, { ...row, connectionId: 'wsl:Debian' }, wsl)
    ).toBeUndefined()
    expect(resolveClaudeHookResumeOrigin(runtime, row, wsl)).toBeUndefined()
    expect(resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'wsl' })).toBeUndefined()
    expect(
      claudeResumeOriginsEqual(
        captured,
        resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'wsl', wslDistro: 'Debian' })
      )
    ).toBe(false)
    expect(
      claudeResumeOriginsEqual(
        captured,
        resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'wsl', wslDistro: 'Ubuntu' })
      )
    ).toBe(true)
    expect(
      claudeResumeOriginsEqual(
        captured,
        resolveClaudeResumeLaunchOrigin(runtime, {
          runtime: 'wsl',
          wslDistro: 'ubuntu'
        })
      )
    ).toBe(true)
  })

  it('does not match a copied profile on another machine or a different installation', () => {
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: 'installation',
      machineBinding: 'machine'
    })
    const captured = resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'host' })
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: 'installation',
      machineBinding: 'other-machine'
    })
    expect(
      claudeResumeOriginsEqual(
        captured,
        resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'host' })
      )
    ).toBe(false)
    publishHostDescriptor(runtime.getRuntimeId(), {
      installationId: 'other-installation',
      machineBinding: 'machine'
    })
    expect(
      claudeResumeOriginsEqual(
        captured,
        resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'host' })
      )
    ).toBe(false)
    expect(claudeResumeOriginsEqual(undefined, undefined)).toBe(false)
  })
})
