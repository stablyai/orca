import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type ModConfig = { modResults: Record<string, unknown>; modRequest: Record<string, unknown> }
type Mod = (config: ModConfig) => Promise<ModConfig>
type PluginConfig = { mods?: { ios?: Record<string, Mod> } }
const withIosSceneLifecycle: ((config: PluginConfig) => PluginConfig) & {
  adoptSceneLifecycle: (contents: string) => string
} = require('../plugins/ios-scene-lifecycle.js')
const { adoptSceneLifecycle } = withIosSceneLifecycle

async function runIosMod(name: string, modResults: Record<string, unknown>): Promise<ModConfig> {
  const mod = withIosSceneLifecycle({}).mods?.ios?.[name]
  if (!mod) {
    throw new Error(`plugin registered no ios.${name} mod`)
  }
  return mod({ modResults, modRequest: {} })
}

// The window block of Expo SDK 55's `ios/HelloWorld/AppDelegate.swift` template.
const TEMPLATE = `@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`

describe('ios-scene-lifecycle plugin', () => {
  it('moves React Native startup out of didFinishLaunching into a scene delegate', () => {
    const out = adoptSceneLifecycle(TEMPLATE)
    expect(out).not.toContain('UIWindow(frame: UIScreen.main.bounds)')
    expect(out).toContain('reactNativeFactory = factory')
    expect(out).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate')
    expect(out).toContain('UIWindow(windowScene: windowScene)')
    expect(out).toContain('connectionOptions.urlContexts.first?.url')
    expect(out).toContain('connectionOptions.userActivities.first')
    expect(out).toContain('appDelegate.application(UIApplication.shared, open: url')
  })

  it('forwards every URL a running scene receives', () => {
    const out = adoptSceneLifecycle(TEMPLATE)
    expect(out).toContain('for context in URLContexts {')
    expect(out).not.toContain('URLContexts.first')
  })

  it('forwards foreground and background transitions to the app delegate', () => {
    const out = adoptSceneLifecycle(TEMPLATE)
    for (const callback of [
      'applicationDidBecomeActive',
      'applicationWillResignActive',
      'applicationWillEnterForeground',
      'applicationDidEnterBackground'
    ]) {
      expect(out).toContain(`delegate?.${callback}?(UIApplication.shared)`)
    }
  })

  it('declares a single scene backed by the generated SceneDelegate', async () => {
    const { modResults } = await runIosMod('infoPlist', {})
    expect(modResults.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate'
          }
        ]
      }
    })
  })

  it('rewrites the Swift AppDelegate through the appDelegate mod', async () => {
    const { modResults } = await runIosMod('appDelegate', {
      language: 'swift',
      contents: TEMPLATE
    })
    expect(modResults.contents).toContain('class SceneDelegate')
  })

  it('is idempotent across repeated prebuilds', () => {
    const once = adoptSceneLifecycle(TEMPLATE)
    expect(adoptSceneLifecycle(once)).toBe(once)
  })

  it('fails loudly when the Expo template changes shape', () => {
    expect(() => adoptSceneLifecycle('class AppDelegate {}')).toThrow(/no longer matches/)
  })
})
