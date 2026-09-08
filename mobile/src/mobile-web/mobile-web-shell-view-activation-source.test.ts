import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const androidModuleSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/ExpoMobileWebShellModule.kt',
    import.meta.url
  ),
  'utf8'
)

describe('hosted shell view activation', () => {
  // The focus effect calls activateViewSession while the sessionId prop commit that registers the
  // view may still be pending. Rejecting there pinned a permanent "Hosted session could not be
  // restored." banner above a healthy page, which also shifted the WebView down.
  it('treats an unregistered view as mid-commit rather than a failure', () => {
    expect(androidModuleSource).toContain(
      'AsyncFunction("activateViewSession") { sessionId: String ->\n' +
        '      sessionViews[sessionId]?.activateSessionView(sessionId)'
    )
    expect(androidModuleSource).toContain(
      'AsyncFunction("deactivateViewSession") { sessionId: String ->\n' +
        '      sessionViews[sessionId]?.deactivateSessionView()'
    )
    expect(androidModuleSource).not.toContain('mobile_web_shell_view_unavailable')
  })

  it('keeps the sessionId prop as the activation authority', () => {
    expect(androidModuleSource).toContain('Prop("sessionId") { view, sessionId: String? ->')
    expect(androidModuleSource).toContain('view.setSessionId(sessionId)')
    expect(androidModuleSource).toContain('sessionViews[sessionId] = view')
  })
})
