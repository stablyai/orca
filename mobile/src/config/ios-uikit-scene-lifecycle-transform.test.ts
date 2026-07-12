import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  SCENE_DELEGATE_SOURCE,
  applySceneInfoPlist,
  rewriteAppDelegate
}: {
  SCENE_DELEGATE_SOURCE: string
  applySceneInfoPlist: (infoPlist: Record<string, unknown>) => Record<string, unknown>
  rewriteAppDelegate: (contents: string) => string
} = require('../../plugins/ios-uikit-scene-lifecycle-transform.js')
const {
  ensureSceneDelegateBuildSource
}: {
  ensureSceneDelegateBuildSource: (
    project: Record<string, unknown>,
    projectName: string,
    addBuildSourceFileToGroup: (args: Record<string, unknown>) => unknown
  ) => void
} = require('../../plugins/ios-uikit-scene-lifecycle.js')

const APP_DELEGATE_TEMPLATE = `class AppDelegate {
  var reactNativeFactory: RCTReactNativeFactory?

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}`

describe('iOS UIKit scene lifecycle transform', () => {
  it('moves the React Native bootstrap to SceneDelegate and is idempotent', () => {
    const rewritten = rewriteAppDelegate(APP_DELEGATE_TEMPLATE)

    expect(rewritten).toContain(
      'SceneDelegate creates the window and starts React Native under the scene lifecycle.'
    )
    expect(rewritten).not.toContain('window = UIWindow(frame: UIScreen.main.bounds)')
    expect(rewritten).not.toContain('factory.startReactNative(')
    expect(rewriteAppDelegate(rewritten)).toBe(rewritten)
  })

  it('rejects a migrated marker when the AppDelegate window bootstrap is still present', () => {
    const partial = APP_DELEGATE_TEMPLATE.replace(
      'window = UIWindow(frame: UIScreen.main.bounds)',
      `// Why: SceneDelegate creates the window and starts React Native under the scene lifecycle.
    window = UIWindow(frame: UIScreen.main.bounds)`
    )

    expect(() => rewriteAppDelegate(partial)).toThrow('partial scene lifecycle migration')
  })

  it('refuses an unknown AppDelegate template instead of silently producing a partial migration', () => {
    expect(() => rewriteAppDelegate('class AppDelegate {}')).toThrow(
      'AppDelegate bootstrap pattern not found'
    )
  })

  it('installs a single-window SceneDelegate manifest', () => {
    expect(applySceneInfoPlist({ CFBundleName: 'Orca' })).toEqual({
      CFBundleName: 'Orca',
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate'
            }
          ]
        }
      }
    })
  })

  it('forwards scene lifecycle events to Expo app delegate subscribers', () => {
    expect(SCENE_DELEGATE_SOURCE).toContain('internal import ExpoModulesCore')
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'ExpoAppDelegateSubscriberManager.applicationDidBecomeActive'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'ExpoAppDelegateSubscriberManager.applicationWillResignActive'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'ExpoAppDelegateSubscriberManager.applicationWillEnterForeground'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'ExpoAppDelegateSubscriberManager.applicationDidEnterBackground'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain('ExpoAppDelegateSubscriberManager.application(')
  })

  it('forwards cold and warm URL and universal-link events', () => {
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'Self.route(urlContexts: connectionOptions.urlContexts)'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain('connectionOptions.userActivities.forEach')
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>)'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain(
      'func scene(_ scene: UIScene, continue userActivity: NSUserActivity)'
    )
    expect(SCENE_DELEGATE_SOURCE).toContain('RCTLinkingManager.application')
    expect(SCENE_DELEGATE_SOURCE).toContain('options[.sourceApplication]')
    expect(SCENE_DELEGATE_SOURCE).toContain('options[.annotation]')
    expect(SCENE_DELEGATE_SOURCE).toContain('options[.openInPlace]')
  })

  it('uses scene-owned startup and fails loudly when AppDelegate is incomplete', () => {
    expect(SCENE_DELEGATE_SOURCE).toContain('@objc(SceneDelegate)')
    expect(SCENE_DELEGATE_SOURCE).toContain('UIWindow(windowScene: windowScene)')
    expect(SCENE_DELEGATE_SOURCE).toContain('launchOptions: nil')
    expect(SCENE_DELEGATE_SOURCE).toContain('fatalError(')
    expect(SCENE_DELEGATE_SOURCE).toContain('func sceneDidDisconnect')
    expect(SCENE_DELEGATE_SOURCE).toContain('window = nil')
  })

  it('propagates Xcode source-link errors instead of swallowing them', () => {
    const project = createUnlinkedProject()

    expect(() =>
      ensureSceneDelegateBuildSource(project, 'Orca', () => {
        throw new Error('xcode source link failed')
      })
    ).toThrow('xcode source link failed')
  })

  it('fails when SceneDelegate cannot be confirmed in the app Sources phase', () => {
    const project = createUnlinkedProject()

    expect(() => ensureSceneDelegateBuildSource(project, 'Orca', () => project)).toThrow(
      'SceneDelegate.swift was not linked to the application Sources build phase'
    )
  })

  it('accepts an existing SceneDelegate reference in the application Sources phase', () => {
    const project = createLinkedProject()

    expect(() =>
      ensureSceneDelegateBuildSource(project, 'Orca', () => {
        throw new Error('already-linked source should not be added again')
      })
    ).not.toThrow()
  })
})

function createUnlinkedProject(): Record<string, unknown> {
  return {
    pbxFileReferenceSection: () => ({}),
    pbxBuildFileSection: () => ({}),
    getTarget: () => ({ uuid: 'APP_TARGET' }),
    pbxSourcesBuildPhaseObj: () => ({ files: [] })
  }
}

function createLinkedProject(): Record<string, unknown> {
  return {
    pbxFileReferenceSection: () => ({
      FILE_REF: { path: 'Orca/SceneDelegate.swift' }
    }),
    pbxBuildFileSection: () => ({
      BUILD_FILE: { fileRef: 'FILE_REF' }
    }),
    getTarget: () => ({ uuid: 'APP_TARGET' }),
    pbxSourcesBuildPhaseObj: () => ({ files: [{ value: 'BUILD_FILE' }] })
  }
}
