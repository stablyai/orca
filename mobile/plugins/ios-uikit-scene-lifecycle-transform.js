const SCENE_DELEGATE_SOURCE = `import UIKit
import React

// Why: iOS 27 / Xcode 27 UIKit requires the scene-based lifecycle. Apps that
// only create UIWindow in AppDelegate hit EXC_BREAKPOINT in
// UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption. Move the RN
// root window onto UIWindowScene here (Apple TN3187).

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
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    guard let factory = appDelegate.reactNativeFactory else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    // Why: under UIScene, cold-start orca://pair URLs land in
    // connectionOptions.urlContexts, not UIApplication launchOptions.
    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[UIApplication.LaunchOptionsKey.url] = url
    }

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions
    )
  }

  // Why: warm opens arrive through the scene callback, not AppDelegate.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      RCTLinkingManager.application(
        UIApplication.shared,
        open: context.url,
        options: [:]
      )
    }
  }
}
`

const BOOTSTRAP_MIGRATED_MARKER = 'self.launchOptions = launchOptions'

function hasMigratedBootstrap(contents) {
  return contents.includes(BOOTSTRAP_MIGRATED_MARKER)
}

function hasAppDelegateOwnedBootstrap(contents) {
  return (
    /\bwindow\s*=\s*UIWindow\s*\(\s*frame:\s*UIScreen\.main\.bounds\s*\)/.test(contents) ||
    /\bfactory\.startReactNative\s*\(/.test(contents)
  )
}

function hasSceneLaunchOptionsProperty(contents) {
  return /\bvar\s+launchOptions\s*:\s*\[UIApplication\.LaunchOptionsKey:\s*Any\]\?/.test(contents)
}

function hasSceneLifecycleArtifacts(contents) {
  return (
    contents.includes('configurationForConnecting') ||
    contents.includes('class SceneDelegate') ||
    contents.includes('SceneDelegate owns the window under the UIScene lifecycle')
  )
}

function throwPartialSceneLifecycleMigration() {
  throw new Error(
    'ios-uikit-scene-lifecycle: partial scene lifecycle migration detected; refuse ambiguous AppDelegate rewrite'
  )
}

function insertSceneConfigurationHook(contents) {
  if (contents.includes('configurationForConnecting')) {
    return contents
  }
  const insertAfter = `return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }`
  const sceneHook = `return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Why: explicitly bind SceneDelegate even if module naming differs.
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }`
  if (!contents.includes(insertAfter)) {
    throw new Error(
      'ios-uikit-scene-lifecycle: could not insert configurationForConnecting; refuse partial rewrite'
    )
  }
  return contents.replace(insertAfter, sceneHook)
}

function rewriteAppDelegate(contents) {
  if (hasMigratedBootstrap(contents)) {
    // Why: the marker is only safe when AppDelegate no longer starts RN or
    // owns a UIWindow; otherwise a previous partial rewrite must fail closed.
    if (!hasSceneLaunchOptionsProperty(contents) || hasAppDelegateOwnedBootstrap(contents)) {
      throwPartialSceneLifecycleMigration()
    }
    return insertSceneConfigurationHook(contents)
  }
  if (hasSceneLifecycleArtifacts(contents)) {
    throwPartialSceneLifecycleMigration()
  }

  let next = contents
  if (!/\bvar\s+launchOptions\s*:/.test(next)) {
    const withLaunchOptions = next.replace(
      /var reactNativeFactory: RCTReactNativeFactory\?/,
      `var reactNativeFactory: RCTReactNativeFactory?
  // Why: SceneDelegate starts RN after UIWindowScene connects.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?`
    )
    if (withLaunchOptions === next) {
      throw new Error(
        'ios-uikit-scene-lifecycle: could not find reactNativeFactory field to attach launchOptions'
      )
    }
    next = withLaunchOptions
  }

  const oldBootstrap = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`
  const newBootstrap = `${BOOTSTRAP_MIGRATED_MARKER}

    // Why: SceneDelegate owns the window under the iOS 27 lifecycle.`
  const beforeBootstrap = next
  if (!next.includes(oldBootstrap)) {
    next = next.replace(
      /window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*\n\s*factory\.startReactNative\(\s*\n\s*withModuleName: "main",\s*\n\s*in: window,\s*\n\s*launchOptions: launchOptions\)/,
      `${BOOTSTRAP_MIGRATED_MARKER}\n    // SceneDelegate owns the window under the iOS 27 lifecycle.`
    )
  } else {
    next = next.replace(oldBootstrap, newBootstrap)
  }
  if (next === beforeBootstrap) {
    throw new Error(
      'ios-uikit-scene-lifecycle: AppDelegate bootstrap pattern not found; refuse silent no-op rewrite'
    )
  }
  return insertSceneConfigurationHook(next)
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
