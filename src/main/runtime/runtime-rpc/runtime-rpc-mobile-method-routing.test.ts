import { describe, expect, it } from 'vitest'
import {
  EXECUTION_HOST_METHODS,
  MOBILE_RPC_METHOD_ROUTES,
  PROJECT_GROUP_MANAGEMENT_METHODS
} from './runtime-rpc-mobile-method-routing'
import { PAIRED_DESKTOP_METHODS } from './runtime-rpc-mobile-paired-desktop-methods'

describe('mobile RPC method routing census', () => {
  it('tags every routed method exactly once', () => {
    expect(PAIRED_DESKTOP_METHODS.length + EXECUTION_HOST_METHODS.length).toBe(
      MOBILE_RPC_METHOD_ROUTES.size
    )
  })

  it.each([
    'jira.status',
    'jira.listIssues',
    'jira.searchIssues',
    'jira.getIssue',
    'jira.issueComments'
  ])('keeps %s on the paired desktop that owns its Jira connection', (method) => {
    expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('paired-desktop')
  })

  it('sends a targeted status to the server, whose features a server workspace gates on', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('status.get')).toBe('execution-host')
  })

  it.each(PROJECT_GROUP_MANAGEMENT_METHODS)(
    'routes project-group management method %s to its execution host',
    (method) => {
      expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('execution-host')
    }
  )

  it.each(['projectGroup.scanNested', 'projectGroup.importNested'])(
    'keeps host-filesystem project discovery method %s unavailable to mobile clients',
    (method) => {
      expect(MOBILE_RPC_METHOD_ROUTES.has(method)).toBe(false)
    }
  )
})
