import { describe, expect, it } from 'vitest'
import { resolveConnectorOrigin } from './connector-origin'

describe('resolveConnectorOrigin', () => {
  it('honors ORCA_CONNECTOR_URL, the legacy host included', () => {
    expect(
      resolveConnectorOrigin({ ORCA_CONNECTOR_URL: 'https://connector.onorca.dev' }, true)
    ).toBe('https://connector.onorca.dev')
    expect(resolveConnectorOrigin({ ORCA_CONNECTOR_URL: 'http://127.0.0.1:8787' }, false)).toBe(
      'http://127.0.0.1:8787'
    )
  })

  it('falls back to the default for an unusable override', () => {
    expect(resolveConnectorOrigin({ ORCA_CONNECTOR_URL: 'http://127.0.0.1:8787' }, true)).toBe(
      'https://connector.orca.dev'
    )
    expect(
      resolveConnectorOrigin({ ORCA_CONNECTOR_URL: 'https://connector.orca.dev/x' }, true)
    ).toBe('https://connector.orca.dev')
  })
})
