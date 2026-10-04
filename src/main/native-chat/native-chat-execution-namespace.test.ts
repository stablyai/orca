import { afterEach, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  antigravitySessionWslDistro,
  configureNativeChatExecutionNamespace
} from './native-chat-execution-namespace'

function row(connectionId: string | null, sessionId = 'conversation'): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    state: 'working',
    prompt: '',
    receivedAt: 1,
    stateStartedAt: 1,
    agentType: 'antigravity',
    connectionId,
    providerSession: { key: 'conversation_id', id: sessionId }
  }
}

afterEach(() => configureNativeChatExecutionNamespace(() => []))

it('reads the current owning-host store on every lookup without caching scope', () => {
  let rows = [row('wsl:Debian'), row('wsl:Ubuntu', 'other')]
  configureNativeChatExecutionNamespace(() => rows)
  expect(antigravitySessionWslDistro('conversation')).toBe('Debian')
  rows = [row('wsl:Ubuntu')]
  expect(antigravitySessionWslDistro('conversation')).toBe('Ubuntu')
})

it.each([
  [row('wsl:Debian'), row('wsl:Ubuntu')],
  [row(null), row('wsl:Debian')]
])('refuses a same-ID ambiguity across execution namespaces', (...rows) => {
  configureNativeChatExecutionNamespace(() => rows)
  expect(() => antigravitySessionWslDistro('conversation')).toThrow('ambiguous')
})

it('does not import direct SSH mirror identity into the local namespace', () => {
  configureNativeChatExecutionNamespace(() => [row('ssh-host'), row('wsl:Debian')])
  expect(() => antigravitySessionWslDistro('conversation')).toThrow('unavailable')
})

it('refuses an unverified WSL relay distro', () => {
  configureNativeChatExecutionNamespace(() => [row('wsl:')])
  expect(() => antigravitySessionWslDistro('conversation')).toThrow('unavailable')
})
