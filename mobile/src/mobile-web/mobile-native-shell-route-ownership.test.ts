import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const nativeLayout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')
const nativeSettings = readFileSync(new URL('../../app/settings.tsx', import.meta.url), 'utf8')
const nativeHome = readFileSync(new URL('../home/MobileHomeHostList.tsx', import.meta.url), 'utf8')
const hybridShell = readFileSync(new URL('../../app/hybrid.tsx', import.meta.url), 'utf8')
const hybridPresentation = readFileSync(
  new URL('./MobileWebHybridShellPresentation.tsx', import.meta.url),
  'utf8'
)
const brokerMessageHandoff = readFileSync(
  new URL('./mobile-web-broker-message-handoff.ts', import.meta.url),
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
    expect(nativeSettings).toContain("router.push('/troubleshoot')")
    expect(nativeSettings).toContain("router.push('/about')")
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

  it('does not add native-shell screens to the desktop-served route graph', () => {
    const hostedRoutePaths = listRouteFiles(hostedRouteRoot)
    for (const routeName of NATIVE_ROUTE_NAMES) {
      expect(hostedRoutePaths).not.toContain(`${routeName}.tsx`)
    }
  })

  it('opens shell-owned screens without clearing the hosted session', () => {
    const settingsBranch = navigationAuthority.match(
      /if \(isMobileWebNativeRoute\(destination\)\) \{([\s\S]*?)\n\s*\}/
    )?.[1]
    expect(settingsBranch).toContain('routeHandoffRef.current.record(requestId, destination)')
    expect(hybridShell).toContain('routeHandoffRef: nativeRouteHandoffRef')
    expect(settingsBranch).not.toContain('setHostedViewActive(false)')
    expect(hybridShell).toContain('handleMobileWebBrokerMessage')
    expect(brokerMessageHandoff).toContain('completeMobileWebNativeRouteHandoffAfterResponse')
    expect(brokerMessageHandoff).toContain('await view.deactivateSessionView()')
    expect(brokerMessageHandoff).toContain('setHostedViewActive: args.setHostedViewActive')
    expect(hybridShell).toContain("router.push('/terminal-settings')")
    expect(hybridShell).toContain("pathname: '/connection-log'")
    expect(hybridShell).toContain('void view.activateSessionView(sessionId)')
    expect(hybridShell).toContain('return () => setHostedViewActive(false)')
    expect(settingsBranch).not.toContain('clearRoute')
    expect(settingsBranch).not.toContain('setSelectedHostId')
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
