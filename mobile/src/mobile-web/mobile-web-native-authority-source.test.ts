import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('mobile web native authority source boundaries', () => {
  it('validates direct native external URLs and keeps shared chat copy injected', () => {
    const authority = readFileSync(
      new URL('./mobile-web-native-capability-authority.ts', import.meta.url),
      'utf8'
    )
    const chatMessage = readFileSync(
      new URL('../session/MobileNativeChatMessage.tsx', import.meta.url),
      'utf8'
    )

    expect(authority).toContain('normalizeMobileWebExternalUrl(url)')
    expect(authority).toContain('Linking.openURL(externalUrl)')
    expect(authority).not.toContain('Linking.openURL(url)')
    expect(chatMessage).toContain('await onCopyText(text)')
    expect(chatMessage).not.toContain('expo-clipboard')
  })

  it('keys hosted native state to paired cryptographic identity', () => {
    const hybridRoute = readFileSync(new URL('../../app/hybrid.tsx', import.meta.url), 'utf8')

    expect(hybridRoute).toContain('hostIdentity: selectedHost.publicKeyB64')
    expect(hybridRoute).not.toContain('hostIdentity: selectedHost.id')
  })
})
