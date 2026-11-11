import { describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { manageClaudeMcp } from './claude-structured-mcp'

const figma: McpServerStatus = {
  name: 'figma',
  status: 'needs-auth',
  scope: 'user',
  config: {
    type: 'http',
    url: 'https://example.invalid/mcp',
    headers: { Authorization: 'private-fixture' }
  }
}

function liveMcp() {
  const session = sessionFor()
  const status = vi.fn(async (): Promise<McpServerStatus[]> => [figma])
  const login = vi.fn(async () => {})
  const reconnect = vi.fn(async () => {})
  const toggle = vi.fn(async () => {})
  Object.assign(session.connection, {
    mcpServerStatus: status,
    loginMcp: login,
    reconnectMcpServer: reconnect,
    toggleMcpServer: toggle
  })
  const sessions = new Map([['chat', session]])
  return { session, sessions, status, login, reconnect, toggle }
}

describe('Claude MCP actions on the owning live session', () => {
  it('waits for browser consent, reconnects that session, and returns only its observed status', async () => {
    const { sessions, status, login, reconnect } = liveMcp()
    const consent = Promise.withResolvers<void>()
    login.mockReturnValue(consent.promise)
    const result = manageClaudeMcp(sessions, 'chat', { action: 'authenticate', server: 'figma' })
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith('figma'))
    expect(reconnect).not.toHaveBeenCalled()
    expect(
      await manageClaudeMcp(sessions, 'chat', { action: 'authenticate', server: 'figma' })
    ).toEqual({ status: 'busy' })
    consent.resolve()
    expect(await result).toEqual({
      status: 'ok',
      servers: [{ name: 'figma', status: 'needs-auth', canAuthenticate: true }]
    })
    expect(reconnect).toHaveBeenCalledWith('figma')
    status.mockResolvedValue([{ ...figma, status: 'connected' }])
    expect(await manageClaudeMcp(sessions, 'chat', { action: 'status' })).toEqual({
      status: 'ok',
      servers: [{ name: 'figma', status: 'connected', canAuthenticate: true }]
    })
  })

  it('does not reconnect a replacement session after a delayed sign-in', async () => {
    const { sessions, login, reconnect } = liveMcp()
    const consent = Promise.withResolvers<void>()
    login.mockReturnValue(consent.promise)
    const result = manageClaudeMcp(sessions, 'chat', { action: 'authenticate', server: 'figma' })
    await vi.waitFor(() => expect(login).toHaveBeenCalled())
    sessions.set('chat', sessionFor())
    consent.resolve()
    expect(await result).toEqual({ status: 'session-changed' })
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('refuses unknown and dynamic servers, and never returns provider auth diagnostics', async () => {
    const { sessions, status, login } = liveMcp()
    expect(
      await manageClaudeMcp(sessions, 'chat', { action: 'authenticate', server: '--unknown' })
    ).toEqual({ status: 'unavailable' })
    status.mockResolvedValue([{ ...figma, scope: 'dynamic' }])
    expect(
      await manageClaudeMcp(sessions, 'chat', { action: 'authenticate', server: 'figma' })
    ).toEqual({ status: 'unavailable' })
    expect(login).not.toHaveBeenCalled()
    status.mockResolvedValue([{ ...figma, source: 'sdk' }])
    expect(
      await manageClaudeMcp(sessions, 'chat', { action: 'authenticate', server: 'figma' })
    ).toEqual({ status: 'unavailable' })
    expect(login).not.toHaveBeenCalled()
    status.mockRejectedValue(new Error('private OAuth URL fixture'))
    expect(await manageClaudeMcp(sessions, 'chat', { action: 'status' })).toEqual({
      status: 'failed'
    })
  })

  it('enables the named server and reads back the live state', async () => {
    const { sessions, status, toggle } = liveMcp()
    status
      .mockResolvedValueOnce([{ ...figma, status: 'disabled' }])
      .mockResolvedValue([{ ...figma, status: 'pending' }])
    expect(
      await manageClaudeMcp(sessions, 'chat', { action: 'toggle', server: 'figma', enabled: true })
    ).toEqual({
      status: 'ok',
      servers: [{ name: 'figma', status: 'pending', canAuthenticate: true }]
    })
    expect(toggle).toHaveBeenCalledWith('figma', true)
  })
})
