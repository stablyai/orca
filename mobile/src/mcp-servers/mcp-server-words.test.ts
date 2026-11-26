import { describe, expect, it } from 'vitest'
import {
  ALL_MCP_WORKSPACES,
  isMcpWorkspaceOn,
  mcpServerRemoveMessage,
  toggleMcpWorkspace
} from './mcp-server-words'

// The phone writes these choices straight to the host; a wrong one turns a server on in a repo the user excluded.
describe('toggleMcpWorkspace', () => {
  it('picks only the tapped workspace from All, so later ones stay off', () => {
    expect(toggleMcpWorkspace(ALL_MCP_WORKSPACES, 'orca')).toEqual({
      later: false,
      on: ['orca'],
      off: []
    })
  })

  it('keeps the choice for later workspaces and moves the key between on and off', () => {
    const allBut = { later: true, on: [], off: ['docs'] }
    const docsBack = toggleMcpWorkspace(allBut, 'docs')
    expect(docsBack).toEqual({ later: true, on: [], off: [] })
    const appOff = toggleMcpWorkspace(allBut, 'app')
    expect(appOff).toEqual({ later: true, on: [], off: ['docs', 'app'] })
    expect(isMcpWorkspaceOn(appOff, 'app')).toBe(false)

    const only = { later: false, on: ['orca'], off: [] }
    expect(toggleMcpWorkspace(only, 'orca')).toEqual({ later: false, on: [], off: [] })
    expect(toggleMcpWorkspace(only, 'app')).toEqual({ later: false, on: ['orca', 'app'], off: [] })
  })
})

// Removing deletes what the user can't get back; the confirm must say which, and never less.
describe('mcpServerRemoveMessage', () => {
  const t = (key: string) => key
  const http = (headers: string[]) => ({
    version: 'v1',
    server: {
      name: 'example',
      url: 'https://mcp.example.test/mcp',
      transport: 'http' as const,
      headers: headers.map((key) => ({ key, configured: true }))
    }
  })
  const command = (env: string[]) => ({
    version: 'v1',
    server: {
      name: 'example',
      command: 'npx',
      args: ['example-mcp'],
      env: env.map((key) => ({ key, configured: true }))
    }
  })

  it('says a held sign-in is deleted, and leaves a signed-out one at the plain line', () => {
    const signedIn = {
      signIn: { state: 'signed-in' as const, limited: false }
    }
    expect(mcpServerRemoveMessage(signedIn, null, t)).toBe('mcpServers.removeMessageSignIn')
    expect(mcpServerRemoveMessage({ signIn: { state: 'lost' } }, null, t)).toBe(
      'mcpServers.removeMessageSignIn'
    )
    expect(mcpServerRemoveMessage({ signIn: { state: 'signed-out' } }, null, t)).toBe(
      'mcpServers.removeMessage'
    )
  })

  it('names saved headers or variables, and assumes saved values until the details are read', () => {
    expect(mcpServerRemoveMessage({}, http(['X-Example-Key']), t)).toBe(
      'mcpServers.removeMessageHeaders'
    )
    expect(mcpServerRemoveMessage({}, command(['EXAMPLE_TOKEN']), t)).toBe(
      'mcpServers.removeMessageVariables'
    )
    expect(mcpServerRemoveMessage({}, null, t)).toBe('mcpServers.removeMessageUnknown')
    expect(mcpServerRemoveMessage({}, http([]), t)).toBe('mcpServers.removeMessage')
    expect(mcpServerRemoveMessage({}, command([]), t)).toBe('mcpServers.removeMessage')
  })
})
