import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const nativeLayout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')
const nativeSettings = readFileSync(new URL('../../app/settings.tsx', import.meta.url), 'utf8')
const settingsMenuItems = readFileSync(
  new URL('../settings/mobile-settings-menu-items.ts', import.meta.url),
  'utf8'
)
const nativeHome = readFileSync(new URL('../home/MobileHomeHostList.tsx', import.meta.url), 'utf8')
const hybridShell = readFileSync(new URL('../../app/hybrid.tsx', import.meta.url), 'utf8')
const hybridPresentation = readFileSync(
  new URL('./MobileWebHybridShellPresentation.tsx', import.meta.url),
  'utf8'
)
const navigationAuthority = readFileSync(
  new URL('./use-mobile-web-navigation-authority.ts', import.meta.url),
  'utf8'
)
const hardwareBackHook = readFileSync(
  new URL('./use-mobile-web-hardware-back-handoff.ts', import.meta.url),
  'utf8'
)
const hostedRouteRoot = new URL('../../host-web-app', import.meta.url)

const NATIVE_ROUTE_NAMES = [
  'settings',
  'terminal-settings',
  'native-chat-settings',
  'browser-settings',
  'voice-settings',
  'notifications',
  'troubleshoot',
  'connection-log',
  'about',
  'mobile-onboarding'
] as const

describe('mobile native shell route ownership', () => {
  it('keeps settings, onboarding, privacy, about, and diagnostics in native routes', () => {
    for (const routeName of NATIVE_ROUTE_NAMES) {
      expect(nativeLayout).toContain(`name="${routeName}"`)
    }
    expect(settingsMenuItems).toContain("push('/troubleshoot')")
    expect(settingsMenuItems).toContain("push('/about')")
    expect(nativeSettings).toContain('mobileSettingsMenuItems((route) => router.push(route))')
    expect(nativeSettings).toContain("Linking.openURL('https://www.onorca.dev/privacy')")
  })

  it('does not expose the hosted workspace as an experimental setting', () => {
    expect(nativeSettings).not.toContain('Open hybrid workspace UI')
    expect(nativeSettings).not.toContain('Hybrid workspace UI')
    expect(nativeSettings).not.toContain('Experimental')
    expect(nativeLayout).toContain(
      'isRetiredNativeWorkspaceRoute(pathname, MOBILE_NATIVE_BASELINE_MODE)'
    )
    expect(nativeLayout).toContain('<Stack.Screen name="h" options={{ headerShown: false }} />')
  })

  it('keeps host selection on the existing native Home presentation', () => {
    expect(nativeHome).toContain('<MobileHostCard')
    expect(hybridPresentation).not.toContain('MobileWebHostPicker')
  })

  it('hosts migrated preferences while retaining native recovery screens', () => {
    const hostedRoutePaths = listRouteFiles(hostedRouteRoot)
    const hostedSettings = [
      'settings',
      'native-chat-settings',
      'browser-settings',
      'troubleshoot',
      'connection-log',
      'notifications',
      'voice-settings',
      'terminal-settings',
      'about'
    ]
    for (const routeName of hostedSettings) {
      expect(hostedRoutePaths).toContain(`${routeName}.tsx`)
    }
    for (const routeName of NATIVE_ROUTE_NAMES.filter((name) => !hostedSettings.includes(name))) {
      expect(hostedRoutePaths).not.toContain(`${routeName}.tsx`)
    }
  })

  it('keeps every page-owned settings route inside the hosted document', () => {
    // Only host exits leave the hosted page; the shell owns no workspace-adjacent route.
    expect(navigationAuthority).not.toContain('isMobileWebNativeRoute')
    expect(hybridShell).not.toContain("router.push('/terminal-settings')")
    expect(hybridShell).not.toContain("pathname: '/connection-log'")
  })

  it('reactivates the hosted session view with the route it left', () => {
    expect(hybridShell).toContain('void view.activateSessionView(sessionId)')
    expect(hybridShell).toContain('return () => setHostedViewActive(false)')
    expect(hybridPresentation).toContain('sessionId={hostedViewActive ? session.sessionId : null}')
  })

  it('does not initialize the page before its capability broker is ready', () => {
    expect(hybridShell).toContain('!brokerRef.current')
    expect(hybridShell).toContain('void postInitRef.current()')
    expect(hybridShell).toContain('postInitRef.current = postInit')
  })

  it('replays the hosted route across a package swap instead of resetting per session', () => {
    expect(hybridShell).toContain('useMobileWebResumeRouteMemory(selectedHostId)')
    expect(hybridShell).toContain('resumeRoute: resumeRoute.current()')
    expect(hybridShell).not.toMatch(/resumeRoute[\s\S]{0,80}\}, \[session\?\.sessionId\]\)/)
  })

  it('does not echo init after the hosted page acknowledges it', () => {
    const readyBranch = hybridShell.match(
      /if \(parsed\.value\.type === 'ready'\) \{([\s\S]*?)\} else if/
    )?.[1]
    expect(readyBranch).toContain('setReadySessionId(current.sessionId)')
    expect(readyBranch).not.toContain('postInit')
  })

  it('returns Android hardware Back to the native host route when the page does not handle it', () => {
    const handleBack = hybridShell.match(
      /const handleBack = useCallback\(\(\) => \{([\s\S]*?)\n\s*\},/
    )?.[1]
    expect(hybridShell).toContain('useMobileWebHardwareBackHandoff')
    expect(hybridShell).toContain('onUnhandled: handleBack')
    expect(handleBack).toContain('leaveHostRoute(router)')
    expect(hardwareBackHook).toContain("Platform.OS !== 'android'")
    expect(hardwareBackHook).toContain("BackHandler.addEventListener('hardwareBackPress'")
  })
})

function listRouteFiles(root: URL): string[] {
  const rootPath = fileURLToPath(root)
  const paths: string[] = []
  const pending = [rootPath]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) {
      continue
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.name.endsWith('.tsx')) {
        paths.push(relative(rootPath, path))
      }
    }
  }
  return paths
}
