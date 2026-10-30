import { describe, expect, it } from 'vitest'
import {
  buildBrowserExtensionBackgroundWrapper,
  withBrowserExtensionApiConnectSource
} from './browser-extension-background-wrapper'

const base = { manifest_version: 3, name: 'Vault', version: '1.0' }

describe('background wrapper', () => {
  it('loads the shim, then the classic worker, through importScripts', () => {
    const wrapper = buildBrowserExtensionBackgroundWrapper({
      ...base,
      background: { service_worker: 'background.js' }
    })
    expect(wrapper?.wrapperPath).toBe('orca-background.js')
    expect(wrapper?.wrapperSource).toContain(
      'importScripts("/orca-extension-api.js", "/background.js");'
    )
    expect(wrapper?.manifest.background).toEqual({ service_worker: 'orca-background.js' })
  })

  it('imports the shim, then the module worker, from beside the original', () => {
    const wrapper = buildBrowserExtensionBackgroundWrapper({
      ...base,
      background: { service_worker: './build/service worker.js', type: 'module' }
    })
    expect(wrapper?.wrapperPath).toBe('build/orca-background.js')
    expect(wrapper?.wrapperSource).toContain(
      'import "/orca-extension-api.js";\nimport "/build/service%20worker.js";'
    )
    expect(wrapper?.manifest.background).toEqual({
      service_worker: 'build/orca-background.js',
      type: 'module'
    })
  })

  it('drops the Firefox background.scripts key that Chromium warns about in MV3', () => {
    const wrapper = buildBrowserExtensionBackgroundWrapper({
      ...base,
      background: {
        service_worker: 'assets/background.js',
        type: 'module',
        scripts: ['assets/background.js']
      }
    })
    expect(wrapper?.manifest.background).toEqual({
      service_worker: 'assets/orca-background.js',
      type: 'module'
    })
  })

  it('leaves extensions without a background worker alone', () => {
    expect(buildBrowserExtensionBackgroundWrapper(base)).toBeNull()
    expect(buildBrowserExtensionBackgroundWrapper({ ...base, background: {} })).toBeNull()
  })

  it('rejects Manifest V2 and workers outside the folder', () => {
    expect(() =>
      buildBrowserExtensionBackgroundWrapper({
        ...base,
        manifest_version: 2,
        background: { scripts: ['bg.js'] }
      })
    ).toThrow('Manifest V3')
    expect(() =>
      buildBrowserExtensionBackgroundWrapper({
        ...base,
        background: { service_worker: '../outside.js' }
      })
    ).toThrow('inside the extension folder')
  })

  it('lets a restrictive extension-pages policy reach the API', () => {
    const wrapper = buildBrowserExtensionBackgroundWrapper({
      ...base,
      background: { service_worker: 'bg.js' },
      content_security_policy: {
        extension_pages: "script-src 'self'; connect-src https://vault.example",
        sandbox: 'sandbox allow-scripts'
      }
    })
    expect(wrapper?.manifest.content_security_policy).toEqual({
      extension_pages:
        "script-src 'self'; connect-src https://vault.example 'self' orca-extension-api:",
      sandbox: 'sandbox allow-scripts'
    })
    expect(withBrowserExtensionApiConnectSource("default-src 'none'; script-src 'self'")).toBe(
      "default-src 'none'; script-src 'self'; connect-src 'self' orca-extension-api:"
    )
    expect(withBrowserExtensionApiConnectSource("script-src 'self'")).toBe("script-src 'self'")
  })
})
