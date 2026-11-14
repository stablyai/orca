import { expect, it, vi } from 'vitest'
import { readBrowserExtensionSessionAccess } from './browser-extension-session-access'

vi.mock('../api-runtime/browser-extension-native-page', () => ({
  runBrowserExtensionNativePage: vi.fn()
}))

it('seeds only a native integer untrusted grant, including last duplicate preference semantics', () => {
  const levels = readBrowserExtensionSessionAccess(`{
    "extensions": { "settings": {
      "granted": { "storage_session_access_level": 2 },
      "string": { "storage_session_access_level": "2" },
      "double": { "storage_session_access_level": 2.0 },
      "trusted": { "storage_session_access_level": 1 },
      "duplicate": { "storage_session_access_level": 2 },
      "duplicate": { "storage_session_access_level": 1 },
      "property": { "storage_session_access_level": 1, "storage_session_access_level": 2 }
    } }
  }`)
  expect([...levels]).toEqual([
    ['granted', 'TRUSTED_AND_UNTRUSTED_CONTEXTS'],
    ['property', 'TRUSTED_AND_UNTRUSTED_CONTEXTS']
  ])
  expect(() => readBrowserExtensionSessionAccess('{"extensions":')).toThrow('Could not read')
})
