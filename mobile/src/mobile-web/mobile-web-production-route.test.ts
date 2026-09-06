import { describe, expect, it } from 'vitest'
import {
  isRetiredNativeWorkspaceRoute,
  mobileHostRouteOwner,
  retiredNativeWorkspaceHostId
} from './mobile-web-production-route'

describe('mobile web production route', () => {
  it.each(['/h', '/h/paired-host', '/h/paired-host/session/workspace'])(
    'retires the native workspace route %s',
    (pathname) => {
      expect(isRetiredNativeWorkspaceRoute(pathname)).toBe(true)
    }
  )

  it('preserves only the exact native host-management route', () => {
    expect(mobileHostRouteOwner('/h/paired-host/edit')).toBe('native-shell')
    expect(isRetiredNativeWorkspaceRoute('/h/paired-host/edit')).toBe(false)
    for (const pathname of [
      '/h//edit',
      '/h/paired-host/Edit',
      '/h/paired-host/edit/extra',
      '/h/paired-host/accounts',
      '/h/paired-host/tasks',
      '/h/paired-host/files/workspace',
      '/h/paired-host/files/preview/workspace',
      '/h/paired-host/source-control/workspace',
      '/h/paired-host/review/workspace',
      '/h/paired-host/history/workspace',
      '/h/paired-host/pr/workspace',
      '/h/paired-host/agent-history/workspace'
    ]) {
      expect(isRetiredNativeWorkspaceRoute(pathname), pathname).toBe(true)
    }
  })

  it('allows workspace routes only in the development baseline mode', () => {
    expect(isRetiredNativeWorkspaceRoute('/h/paired-host/session/workspace', true)).toBe(false)
    expect(isRetiredNativeWorkspaceRoute('/h/paired-host/session/workspace', false)).toBe(true)
  })

  it('extracts a bounded route host without confusing malformed encodings', () => {
    expect(retiredNativeWorkspaceHostId('/h/host%2Fone/session/workspace')).toBe('host/one')
    expect(retiredNativeWorkspaceHostId('/h/%/session/workspace')).toBeUndefined()
    expect(retiredNativeWorkspaceHostId('/h/host/edit')).toBeUndefined()
  })

  it.each(['/', '/hybrid', '/settings', '/history'])('preserves shell route %s', (pathname) => {
    expect(isRetiredNativeWorkspaceRoute(pathname)).toBe(false)
  })
})
