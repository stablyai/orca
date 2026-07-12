const SCENE_DELEGATE_SOURCE = `internal import ExpoModulesCore
import React
import UIKit

// Why: Expo SDK 55 predates the scene-based lifecycle required by the iOS 27 SDK.
// Keep this compatibility delegate aligned with Expo's scene lifecycle behavior.
@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory else {
      fatalError(
        "SceneDelegate could not start React Native because AppDelegate did not provide its factory."
      )
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // Scene connection options replace application launch options for links.
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: nil
    )

    Self.route(urlContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { Self.route(userActivity: $0) }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  // UIKit no longer sends these callbacks to AppDelegate after scene adoption.
  func sceneDidBecomeActive(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    Self.route(urlContexts: URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    Self.route(userActivity: userActivity)
  }

  private static func route(urlContexts: Set<UIOpenURLContext>) {
    for context in urlContexts {
      let options = openURLOptions(from: context.options)
      _ = ExpoAppDelegateSubscriberManager.application(
        UIApplication.shared,
        open: context.url,
        options: options
      )
      _ = RCTLinkingManager.application(
        UIApplication.shared,
        open: context.url,
        options: options
      )
    }
  }

  private static func openURLOptions(
    from sceneOptions: UIScene.OpenURLOptions
  ) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let sourceApplication = sceneOptions.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = sceneOptions.annotation {
      options[.annotation] = annotation
    }
    options[.openInPlace] = sceneOptions.openInPlace
    return options
  }

  private static func route(userActivity: NSUserActivity) {
    _ = ExpoAppDelegateSubscriberManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
    _ = RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }
}
`

const MIGRATED_BOOTSTRAP_MARKER =
  'SceneDelegate creates the window and starts React Native under the scene lifecycle.'

function hasAppDelegateOwnedBootstrap(contents) {
  return (
    /\bwindow\s*=\s*UIWindow\s*\(\s*frame:\s*UIScreen\.main\.bounds\s*\)/.test(contents) ||
    /\bfactory\.startReactNative\s*\(/.test(contents)
  )
}

function rewriteAppDelegate(contents) {
  if (contents.includes(MIGRATED_BOOTSTRAP_MARKER)) {
    if (hasAppDelegateOwnedBootstrap(contents)) {
      throw new Error(
        'ios-uikit-scene-lifecycle: partial scene lifecycle migration detected; refuse ambiguous AppDelegate rewrite'
      )
    }
    return contents
  }

  const oldBootstrap = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`
  const newBootstrap = `    // Why: ${MIGRATED_BOOTSTRAP_MARKER}`
  const rewritten = contents.replace(oldBootstrap, newBootstrap)
  if (rewritten === contents) {
    throw new Error(
      'ios-uikit-scene-lifecycle: AppDelegate bootstrap pattern not found; refuse silent no-op rewrite'
    )
  }
  return rewritten
}

function applySceneInfoPlist(infoPlist) {
  return {
    ...infoPlist,
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
  }
}

module.exports = {
  SCENE_DELEGATE_SOURCE,
  applySceneInfoPlist,
  rewriteAppDelegate
}
