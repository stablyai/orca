const { withAppDelegate, withInfoPlist } = require('expo/config-plugins')

// Why: iOS 27 traps at launch (UIKit `…NoSceneLifecycleAdoption`) when an app built
// against the iOS 27 SDK has no scene manifest. Expo SDK 55's template still builds
// its window in `didFinishLaunching`, so this plugin declares one scene and moves
// window creation into a scene delegate. Deep links arrive through the scene too.

const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate'
const MARKER = '// orca: scene lifecycle'

const WINDOW_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/

const SCENE_DELEGATE_SOURCE = `
${MARKER}
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    // Why: a cold-start link is delivered only here under scenes, not to open:url: or
    // continue:. RN reads launch options; expo-linking's registry needs the delegate call.
    // Both keep one initial URL, so only one is forwarded or the two would disagree.
    let url = connectionOptions.urlContexts.first?.url
    let activity = connectionOptions.userActivities.first
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url {
      launchOptions[.url] = url
    }
    if let activity {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ] as [String: Any]
    }
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
    if let url {
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
    }
    if let activity {
      _ = appDelegate.application(
        UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  // Why: with a scene manifest UIKit stops sending these to the app delegate, so
  // Expo's subscribers would never hear foreground/background transitions.
  func sceneDidBecomeActive(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationDidBecomeActive?(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationWillResignActive?(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationWillEnterForeground?(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationDidEnterBackground?(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let source = context.options.sourceApplication {
        options[.sourceApplication] = source
      }
      _ = UIApplication.shared.delegate?.application?(
        UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = UIApplication.shared.delegate?.application?(
      UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`

function adoptSceneLifecycle(contents) {
  if (contents.includes(MARKER)) {
    return contents
  }
  if (!WINDOW_BLOCK.test(contents)) {
    throw new Error(
      'ios-scene-lifecycle: AppDelegate.swift no longer matches the Expo template this plugin ' +
        'rewrites. Update plugins/ios-scene-lifecycle.js for the new template.'
    )
  }
  return contents.replace(WINDOW_BLOCK, '\n') + SCENE_DELEGATE_SOURCE
}

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: SCENE_DELEGATE_CLASS
          }
        ]
      }
    }
    return cfg
  })
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('ios-scene-lifecycle: expected a Swift AppDelegate')
    }
    cfg.modResults.contents = adoptSceneLifecycle(cfg.modResults.contents)
    return cfg
  })
}

module.exports = withIosSceneLifecycle
module.exports.adoptSceneLifecycle = adoptSceneLifecycle
