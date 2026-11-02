import { describe, expect, it, vi } from 'vitest'
import {
  allowsPlaintextOrcaCloudSession,
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from './profile-cloud-auth-config'

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

describe('Orca cloud auth config', () => {
  it('rejects loopback HTTP endpoints in packaged builds', () => {
    expect(
      getOrcaCloudAuthConfig(
        {
          ORCA_CLOUD_API_URL: 'http://localhost:4100',
          ORCA_CLOUD_CLIENT_ID: 'desktop-client'
        },
        true
      )
    ).toMatchObject({ configured: false })

    const httpsState = getOrcaCloudAuthConfig(
      {
        ORCA_CLOUD_API_URL: 'https://orca-cloud.example',
        ORCA_CLOUD_CLIENT_ID: 'desktop-client'
      },
      true
    )
    expect(httpsState.configured).toBe(true)
  })

  it('rejects non-HTTPS non-loopback API URLs', () => {
    expect(
      getOrcaCloudAuthConfig({
        ORCA_CLOUD_API_URL: 'http://orca-cloud.example',
        ORCA_CLOUD_CLIENT_ID: 'desktop-client'
      })
    ).toMatchObject({ configured: false })
  })

  it('ignores dev flags in packaged builds even without NODE_ENV', () => {
    expect(allowsPlaintextOrcaCloudSession({ ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1' }, true)).toBe(
      false
    )
    expect(isOrcaCloudDevAuthEnabled({ ORCA_CLOUD_DEV_AUTH: '1' }, true)).toBe(false)
  })
})
