const fs = require('node:fs')
const path = require('node:path')
const { withInfoPlist, withXcodeProject } = require('expo/config-plugins')

const TARGET = 'OrcaSessionActivity'

module.exports = function withIosLiveActivities(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSSupportsLiveActivities = true
    return cfg
  })
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const root = cfg.modRequest.projectRoot
    const output = path.join(cfg.modRequest.platformProjectRoot, TARGET)
    fs.mkdirSync(output, { recursive: true })
    for (const [source, name] of [
      [
        'modules/orca-live-activities/ios/OrcaSessionAttributes.swift',
        'OrcaSessionAttributes.swift'
      ],
      ['live-activity-widget/OrcaSessionWidget.swift', 'OrcaSessionWidget.swift']
    ]) {
      fs.copyFileSync(path.join(root, source), path.join(output, name))
    }
    fs.writeFileSync(
      path.join(output, `${TARGET}-Info.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Orca</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
</dict></plist>
`
    )
    const targets = project.pbxNativeTargetSection()
    const existing = Object.entries(targets).find(
      ([id, target]) => !id.endsWith('_comment') && target.name?.replaceAll('"', '') === TARGET
    )
    const target = existing
      ? { uuid: existing[0], pbxNativeTarget: existing[1] }
      : project.addTarget(TARGET, 'app_extension', TARGET, `${cfg.ios.bundleIdentifier}.activity`)
    if (!existing) {
      const group = project.addPbxGroup([], TARGET, TARGET)
      project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup)
      project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid)
      project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
      for (const name of ['OrcaSessionAttributes.swift', 'OrcaSessionWidget.swift']) {
        project.addSourceFile(name, { target: target.uuid }, group.uuid)
      }
    }
    const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList]
    for (const item of list.buildConfigurations) {
      Object.assign(project.pbxXCBuildConfigurationSection()[item.value].buildSettings, {
        SWIFT_VERSION: '5.0',
        IPHONEOS_DEPLOYMENT_TARGET: '16.4',
        TARGETED_DEVICE_FAMILY: '"1,2"',
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        CODE_SIGN_STYLE: 'Automatic',
        MARKETING_VERSION: cfg.version,
        CURRENT_PROJECT_VERSION: cfg.ios.buildNumber ?? '1',
        ...(cfg.ios.appleTeamId ? { DEVELOPMENT_TEAM: cfg.ios.appleTeamId } : {})
      })
    }
    return cfg
  })
}
