const { withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// Why: apps built with the iOS 27 SDK must adopt the UIScene lifecycle —
// UIKit traps at launch otherwise. The Expo/RN 0.83 template still creates the
// window in AppDelegate, so this plugin adds the scene manifest plus a
// SceneDelegate adapter that attaches that window to the scene and forwards
// URL/user-activity events that no longer reach the app delegate.
const SCENE_DELEGATE_SOURCE = `import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let appWindow = appDelegate.window
    else { return }
    appWindow.windowScene = windowScene
    window = appWindow
    window?.makeKeyAndVisible()
    // Why: a launch URL arrives only here under the scene lifecycle, so a cold
    // start from a pairing link would otherwise be dropped.
    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
    for activity in connectionOptions.userActivities {
      appDelegate.application(
        UIApplication.shared,
        continue: activity,
        restorationHandler: { _ in }
      )
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let url = URLContexts.first?.url
    else { return }
    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    appDelegate.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  // Why: under scenes UIKit stops calling the app delegate's lifecycle methods,
  // so forward them to keep ExpoAppDelegate subscribers working.
  func sceneDidBecomeActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidBecomeActive?(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillResignActive?(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillEnterForeground?(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidEnterBackground?(UIApplication.shared)
  }
}
`

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
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
    return cfg
  })
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const filepath = path.join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName ?? '',
        'SceneDelegate.swift'
      )
      fs.writeFileSync(filepath, SCENE_DELEGATE_SOURCE)
      return cfg
    }
  ])
  config = withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName ?? ''
    const project = cfg.modResults
    const filepath = `${projectName}/SceneDelegate.swift`
    if (!project.hasFile(filepath)) {
      const group =
        project.findPBXGroupKey({ name: projectName }) ??
        project.getFirstProject().firstProject.mainGroup
      project.addSourceFile(filepath, { target: project.getFirstTarget().uuid }, group)
    }
    return cfg
  })
  return config
}

module.exports = withIosSceneLifecycle
