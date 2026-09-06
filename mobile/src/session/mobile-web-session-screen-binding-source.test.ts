import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSourceFamily } from './mobile-session-route-source-family.test-support'

const hostedSessionRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const nativeSessionRoute = readMobileSessionRouteSourceFamily()
const hostedLayout = readFileSync(
  new URL('../../host-web-app/_layout.tsx', import.meta.url),
  'utf8'
)

describe('mobile web session screen binding', () => {
  it('mounts the existing mobile session route instead of copied presentation', () => {
    expect(hostedSessionRoute).toContain(
      "import { SessionScreen } from '../../../../app/h/[hostId]/session/[worktreeId]'"
    )
    expect(hostedSessionRoute).toContain('webHostSessionTabOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionQuickCommandOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionTerminalOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionFileOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionMarkdownOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionDeviceOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionBrowserOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionDictationOperations(shell.client)')
    expect(hostedSessionRoute).toContain('webHostSessionNativeChatOperations(shell.client)')
    expect(hostedSessionRoute).toContain('sessionTerminalOperations={sessionTerminalOperations}')
    expect(hostedSessionRoute).toContain(
      'sessionQuickCommandOperations={sessionQuickCommandOperations}'
    )
    expect(hostedSessionRoute).toContain('sessionFileOperations={sessionFileOperations}')
    expect(hostedSessionRoute).toContain('sessionMarkdownOperations={sessionMarkdownOperations}')
    expect(hostedSessionRoute).toContain('sessionDeviceOperations={sessionDeviceOperations}')
    expect(hostedSessionRoute).toContain('sessionBrowserOperations={sessionBrowserOperations}')
    expect(hostedSessionRoute).toContain('sessionDictationOperations={sessionDictationOperations}')
    expect(hostedSessionRoute).toContain(
      'sessionNativeChatOperations={sessionNativeChatOperations}'
    )
    expect(hostedSessionRoute).toContain('reconnect={() =>')
    expect(hostedSessionRoute).toContain('reconnectAttempts={shell.reconnectAttempts}')
    expect(hostedSessionRoute).toContain('lastConnectedAt={shell.lastConnectedAt}')
    expect(hostedSessionRoute).toContain('<SessionScreen')
    expect(nativeSessionRoute).toContain('export function SessionScreen(')
    // The native-only API bans moved to hosted-route-native-api-census.test.ts, which walks
    // every module the hosted session route reaches rather than this fixed file list.
    expect(nativeSessionRoute).toContain('sessionDeviceOperations?.openTerminalSettings()')
    expect(nativeSessionRoute).toContain(
      'sessionDeviceOperations?.loadTerminalAccessoryPreferences()'
    )
    expect(nativeSessionRoute).toContain('sessionDeviceOperations?.saveTerminalCustomKeys(keys)')
    expect(nativeSessionRoute).not.toContain('void saveTerminalTextScale(scale)')
    expect(nativeSessionRoute).not.toContain("sendRequest('markdown.readTab'")
    expect(nativeSessionRoute).not.toContain("sendRequest('markdown.saveTab'")
    expect(nativeSessionRoute).toContain('startRuntimeCapabilityRead(')
    expect(nativeSessionRoute).toContain('sessionTabOperations.runtimeCapabilities()')
    expect(nativeSessionRoute).toContain('operations={sessionQuickCommandOperations}')
    expect(nativeSessionRoute).not.toContain("sendRequest('settings.getTerminalQuickCommands'")
    expect(nativeSessionRoute).not.toContain("sendRequest('settings.updateTerminalQuickCommands'")
    expect(nativeSessionRoute).not.toContain('startRuntimeCapabilityProbe(client,')
    expect(nativeSessionRoute).toContain('operations={sessionBrowserOperations}')
    expect(nativeSessionRoute).toMatch(
      /key=\{t\.id\}[\s\S]{0,200}?accessibilityRole="button"[\s\S]{0,200}?style=/
    )
    expect(hostedSessionRoute).not.toMatch(/StyleSheet|className|<View|<Text|<Pressable|<div/)
  })

  it('keeps one native-shell channel alive across hosted route navigation', () => {
    expect(hostedLayout).toContain('installMobileWebHistoryUrlRewriter(')
    expect(hostedLayout).toContain('<MobileWebNativeShellProvider>')
    expect(hostedLayout).toContain('<Stack screenOptions={{ headerShown: false }} />')
    expect(hostedLayout.indexOf('installMobileWebHistoryUrlRewriter(')).toBeLessThan(
      hostedLayout.indexOf('export default function HostMobileWebLayout()')
    )
    expect(hostedLayout.indexOf('<MobileWebNativeShellProvider>')).toBeLessThan(
      hostedLayout.indexOf('<Stack screenOptions={{ headerShown: false }} />')
    )
  })
})
