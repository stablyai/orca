import { expect, it, vi } from 'vitest'
import { decideAgentLaunchMode, resolveAgentLaunchModeOnHost } from './agent-launch-mode'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../shared/remote-runtime-client-capabilities'
import {
  CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../shared/protocol-version'
import { resolveStructuredNativeChatSupport } from '../../shared/structured-native-chat-launch-route'
import { supportsCursorStructuredSessions } from '../runtime/rpc/methods/structured-agent-session-gate'
import type { RpcContext } from '../runtime/rpc/core'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

it('asks the execution host before settling a Cursor native launch in a folder workspace', async () => {
  const getStructuredAgentSessionCreateSupport = vi.fn(async () => ({ supported: true }))
  const preflight = decideAgentLaunchMode({
    placement: { agent: 'cursor', workspaceKind: 'folder' },
    settings: {
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: true
    }
  })
  expect(preflight.mode).toBe('structured')
  const settled = await resolveAgentLaunchModeOnHost(
    { getStructuredAgentSessionCreateSupport },
    preflight,
    'folder:independent-review',
    'cursor'
  )
  expect({ calls: getStructuredAgentSessionCreateSupport.mock.calls, mode: settled.mode }).toEqual({
    calls: [['id:folder:independent-review', 'cursor']],
    mode: 'structured'
  })
})

it('keeps paired desktop Cursor launch choice consistent with actual RPC admission', () => {
  const clientCapabilities = remoteRuntimeClientCapabilities(
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  const route = resolveStructuredNativeChatSupport({
    agent: 'cursor',
    executionHostId: 'runtime:independent-review',
    workspaceKind: 'folder',
    hostCapabilities: RUNTIME_CAPABILITIES,
    clientCapabilities
  })
  const context: RpcContext = {
    runtime: new OrcaRuntimeService(null),
    clientKind: 'runtime',
    clientCapabilities
  }
  expect({ route: route.supported, admitted: supportsCursorStructuredSessions(context) }).toEqual({
    route: true,
    admitted: true
  })
})

it('refuses an old paired client lacking Cursor without granting another provider capability', () => {
  const clientCapabilities = remoteRuntimeClientCapabilities(
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  ).filter((value) => value !== CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  const context: RpcContext = {
    runtime: new OrcaRuntimeService(null),
    clientKind: 'runtime',
    clientCapabilities
  }
  expect(supportsCursorStructuredSessions(context)).toBe(false)
  expect(
    resolveStructuredNativeChatSupport({
      agent: 'cursor',
      executionHostId: 'runtime:old-client',
      workspaceKind: 'folder',
      hostCapabilities: RUNTIME_CAPABILITIES,
      clientCapabilities
    })
  ).toEqual({ supported: false, blocker: 'client-capability' })
})
