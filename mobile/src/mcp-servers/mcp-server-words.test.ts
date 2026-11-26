import { describe, expect, it } from 'vitest'
import { ALL_MCP_WORKSPACES, isMcpWorkspaceOn, toggleMcpWorkspace } from './mcp-server-words'

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
