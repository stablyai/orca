import { describe, expect, it } from 'vitest'
import { DESKTOP_BROWSER_BRIDGE_METHODS } from '../../../shared/desktop-browser-bridge-protocol'
import { ALL_RPC_METHODS } from '../rpc/methods'

describe('desktop browser bridge allowlist', () => {
  const registered = new Map<string, (typeof ALL_RPC_METHODS)[number]>(
    ALL_RPC_METHODS.map((method) => [method.name, method])
  )

  it('names only real one-shot browser methods in the workspace tier', () => {
    for (const name of DESKTOP_BROWSER_BRIDGE_METHODS) {
      const method = registered.get(name)
      expect(method, name).toBeDefined()
      expect(name.startsWith('browser.'), name).toBe(true)
      expect(method?.permission, name).toBe('workspace')
      expect('stream' in (method ?? {}), name).toBe(false)
    }
  })

  it('leaves out every browser method that touches desktop files, secrets or browser identity', () => {
    const excluded = [...registered.keys()].filter(
      (name) => name.startsWith('browser.') && !DESKTOP_BROWSER_BRIDGE_METHODS.has(name)
    )
    expect(excluded).toEqual(
      expect.arrayContaining([
        'browser.upload',
        'browser.download',
        'browser.pdf',
        'browser.exec',
        'browser.cookie.get',
        'browser.cookie.set',
        'browser.cookie.delete',
        'browser.network',
        'browser.clipboardRead',
        'browser.clipboardWrite',
        'browser.storage.local.get',
        'browser.profileImportFromBrowser',
        'browser.profileCreate',
        'browser.profileDelete',
        'browser.tabSetProfile',
        'browser.identity.set',
        'browser.setCredentials',
        'browser.setHeaders',
        'browser.intercept.enable',
        'browser.certificate.proceed',
        'browser.screencast',
        'browser.openUrl',
        'browser.clientHost.attach'
      ])
    )
  })
})
