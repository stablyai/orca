const {
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  IOSConfig
} = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// Why: iOS 27 / Xcode 27 UIKit aborts apps that still own UIWindow only from
// AppDelegate (UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
// Expo prebuild still emits that template; this plugin rewrites it to a
// SceneDelegate-based lifecycle so TestFlight and local device builds launch
// on iOS 27. See Apple TN3187 and expo/expo#46664.

const SCENE_DELEGATE_SOURCE = `import UIKit

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

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions
    )
  }
}
`

function rewriteAppDelegate(contents) {
  if (contents.includes('class SceneDelegate') || contents.includes('configurationForConnecting')) {
    return contents
  }

  // Ensure launchOptions storage + factory fields stay public for SceneDelegate.
  let next = contents.replace(
    /var reactNativeFactory: RCTReactNativeFactory\?/,
    `var reactNativeFactory: RCTReactNativeFactory?
  // Why: SceneDelegate starts RN after the UIWindowScene connects; keep the
  // original launchOptions so deep links / cold-start params still work.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?`
  )

  // Replace window-owned RN bootstrap with deferred SceneDelegate bootstrap.
  const oldBootstrap = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`

  const newBootstrap = `self.launchOptions = launchOptions

    // Why: do not create UIWindow here — SceneDelegate owns the window under
    // the UIScene lifecycle required by iOS 27.`

  if (!next.includes(oldBootstrap)) {
    // Fallback for slightly reformatted templates.
    next = next.replace(
      /window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*\n\s*factory\.startReactNative\(\s*\n\s*withModuleName: "main",\s*\n\s*in: window,\s*\n\s*launchOptions: launchOptions\)/,
      'self.launchOptions = launchOptions\n    // SceneDelegate owns the window under the UIScene lifecycle required by iOS 27.'
    )
  } else {
    next = next.replace(oldBootstrap, newBootstrap)
  }

  if (!next.includes('configurationForConnecting')) {
    const insertAfter = `return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }`
    const sceneHook = `return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Why: explicit scene configuration so UIKit uses SceneDelegate even if
  // Info.plist naming differs across build modules.
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
    if (next.includes(insertAfter)) {
      next = next.replace(insertAfter, sceneHook)
    }
  }

  return next
}

function withSceneInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
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
}

function withSceneDelegateFile(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot)
      const appDir = path.join(projectRoot, projectName)

      fs.writeFileSync(path.join(appDir, 'SceneDelegate.swift'), SCENE_DELEGATE_SOURCE)

      const appDelegatePath = path.join(appDir, 'AppDelegate.swift')
      if (fs.existsSync(appDelegatePath)) {
        const original = fs.readFileSync(appDelegatePath, 'utf8')
        const rewritten = rewriteAppDelegate(original)
        if (rewritten !== original) {
          fs.writeFileSync(appDelegatePath, rewritten)
        }
      }

      return cfg
    }
  ])
}

function withSceneDelegateXcodeProject(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot)
    const filePath = `${projectName}/SceneDelegate.swift`

    // Why: prebuild may re-run; skip if the file is already linked.
    try {
      const section =
        typeof project.pbxFileReferenceSection === 'function'
          ? project.pbxFileReferenceSection()
          : project.pbxFileReferenceSection
      const alreadyLinked = Object.values(section ?? {}).some(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.path === 'string' &&
          entry.path.includes('SceneDelegate.swift')
      )
      if (!alreadyLinked) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: filePath,
          groupName: projectName,
          project
        })
      }
    } catch {
      // Best-effort: file is still written to disk for manual Xcode include.
    }

    return cfg
  })
}

module.exports = function withIosUIKitSceneLifecycle(config) {
  config = withSceneInfoPlist(config)
  config = withSceneDelegateFile(config)
  config = withSceneDelegateXcodeProject(config)
  return config
}
