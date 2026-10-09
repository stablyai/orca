import { describe, expect, it } from 'vitest'
import {
  storedOauthCredentialDiffers,
  withClaudeManagedCredentialRotation
} from './managed-credential-rotation'

describe('withClaudeManagedCredentialRotation', () => {
  it('runs a second rotation only after the first one finishes', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const first = withClaudeManagedCredentialRotation(
      'account-1',
      () =>
        new Promise<void>((resolve) => {
          order.push('first-start')
          releaseFirst = () => {
            order.push('first-end')
            resolve()
          }
        })
    )
    const second = withClaudeManagedCredentialRotation('account-1', async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('does not hold a different account behind the first rotation', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const first = withClaudeManagedCredentialRotation(
      'account-1',
      () =>
        new Promise<void>((resolve) => {
          order.push('first-start')
          releaseFirst = () => {
            order.push('first-end')
            resolve()
          }
        })
    )
    const second = withClaudeManagedCredentialRotation('account-2', async () => {
      order.push('second')
    })

    await second
    expect(order).toEqual(['first-start', 'second'])
    releaseFirst()
    await first
    expect(order).toEqual(['first-start', 'second', 'first-end'])
  })

  it('treats a replaced access token as a different blob when the refresh token matches', () => {
    const snapshot = JSON.stringify({
      claudeAiOauth: { accessToken: 'old-access', refreshToken: 'same-refresh' }
    })
    const stored = JSON.stringify({
      claudeAiOauth: { accessToken: 'new-access', refreshToken: 'same-refresh' }
    })
    expect(storedOauthCredentialDiffers(stored, snapshot)).toBe(true)
    expect(storedOauthCredentialDiffers(snapshot, snapshot)).toBe(false)
  })
})
