import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'

describe('mobile RPC method routing census', () => {
  it.each([
    'jira.status',
    'jira.listIssues',
    'jira.searchIssues',
    'jira.getIssue',
    'jira.issueComments'
  ])('keeps %s on the paired desktop that owns its Jira connection', (method) => {
    expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('paired-desktop')
  })

  it('routes no per-section collapse write while the sidebar-inputs switch is off', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.has('ui.setCollapsed')).toBe(false)
  })

  it('sends a targeted status to the server, whose features a server workspace gates on', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('status.get')).toBe('execution-host')
  })

  it('keeps discovery and explicit PATH refresh on the selected answering host', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('preflight.detectAgents')).toBe('execution-host')
    expect(MOBILE_RPC_METHOD_ROUTES.get('preflight.refreshAgents')).toBe('execution-host')
  })
})
