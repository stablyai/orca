import { describe, expect, it } from 'vitest'
import { isAgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import { resolveStructuredNativeChatSupport } from '../../shared/structured-native-chat-launch-route'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { resolveAgentLaunchCommand } from '../../shared/tui-agent-launch-command'
import { supportsDshAcpVersion, resolveDshHome } from './dsh-structured-launch-resolution'
import { supportsDshStructuredLocation } from './dsh-structured-location-support'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'

describe('official DeepSeek Harness admission', () => {
  it('offers a distinct protocol route and preserves the community terminal command', () => {
    expect(isAgentSessionHandleProvider('dsh-acp')).toBe(true)
    expect(TUI_AGENT_CONFIG['dsh-acp'].launchTransport).toBe('structured')
    expect(TUI_AGENT_CONFIG.dsh.launchTransport).toBeUndefined()
    expect(TUI_AGENT_CONFIG.dsh.launchCmd).toBe('dsh-tui .')
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'refuses terminal overrides on %s for official ACP',
    (platform) => {
      expect(
        resolveAgentLaunchCommand({
          agent: 'dsh-acp',
          platform,
          shell: platform === 'win32' ? 'powershell' : 'posix',
          cmdOverrides: { 'dsh-acp': 'dsh-tui .' },
          agentArgs: '--resume community-session'
        })
      ).toMatchObject({ ok: false })
    }
  )

  it('requires the execution host to advertise official ACP before sending its provider enum', () => {
    const input = {
      agent: 'dsh-acp' as const,
      executionHostId: 'local',
      workspaceKind: 'folder' as const,
      hostCapabilities: ['agent-session.structured.v1']
    }
    expect(resolveStructuredNativeChatSupport(input)).toEqual({
      supported: false,
      blocker: 'runtime-capability'
    })
    expect(
      resolveStructuredNativeChatSupport({ ...input, hostCapabilities: RUNTIME_CAPABILITIES })
    ).toEqual({ supported: true })
  })

  it('refuses SSH and WSL execution instead of substituting a local CLI', () => {
    const input = {
      agent: 'dsh-acp' as const,
      executionHostId: 'ssh:task-host',
      hostCapabilities: RUNTIME_CAPABILITIES
    }
    expect(resolveStructuredNativeChatSupport(input)).toEqual({
      supported: false,
      blocker: 'remote-execution-host'
    })
  })
  it('refuses an inherited terminal transport and WSL before launching any provider', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'dsh-acp',
        cmdOverrides: {},
        platform: process.platform,
        shell: process.platform === 'win32' ? 'powershell' : 'posix'
      })
    ).toMatchObject({ ok: false })
    expect(
      supportsDshStructuredLocation({
        executionHostId: 'local',
        wslDistro: 'Ubuntu',
        workspaceId: 'folder',
        workspaceKind: 'folder'
      })
    ).toBe(false)
    expect(
      resolveStructuredNativeChatSupport({
        agent: 'dsh-acp',
        executionHostId: 'local',
        hostCapabilities: RUNTIME_CAPABILITIES,
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'folder',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'wsl'
          }
        }
      })
    ).toEqual({ supported: false, blocker: 'project-runtime' })
  })
  it('uses the installed CLI version and absolute host home instead of the ACP agentInfo label', () => {
    expect(supportsDshAcpVersion('0.2.1-alpha.1')).toBe(true)
    expect(supportsDshAcpVersion('0.0.1')).toBe(false)
    expect(supportsDshAcpVersion('0.2.0-rc.2')).toBe(false)
    expect(supportsDshAcpVersion('community dsh')).toBe(false)
    expect(() => resolveDshHome({ DSH_HOME: 'relative-home' })).toThrow('absolute')
  })
})
