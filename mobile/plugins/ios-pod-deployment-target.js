const { withPodfile } = require('expo/config-plugins')

// Why: `ios.deploymentTarget` sets the app and the Podfile platform, but each pod keeps
// the minimum from its own podspec (SDWebImage 9.0, RNSVG 12.4, …). Xcode 27 refuses
// pods below iOS 15, and expo-router's LinkPreview needs 16, so raise every pod to the
// app's target after React Native's own post_install.

const MARKER = '# orca: pod deployment target'

const HOOK = `
    ${MARKER}
    app_deployment_target = podfile_properties['ios.deploymentTarget']
    if app_deployment_target
      installer.pods_project.targets.each do |target|
        target.build_configurations.each do |build_config|
          current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
          if current.nil? || Gem::Version.new(current) < Gem::Version.new(app_deployment_target)
            build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_deployment_target
          end
        end
      end
    end
`

const POST_INSTALL_CALL = /(\n(\s*)react_native_post_install\([\s\S]*?\n\2\)\n)/

function addPodDeploymentTargetHook(contents) {
  if (contents.includes(MARKER)) {
    return contents
  }
  if (!POST_INSTALL_CALL.test(contents)) {
    throw new Error(
      'ios-pod-deployment-target: Podfile has no react_native_post_install(...) call to follow. ' +
        'Update plugins/ios-pod-deployment-target.js for the new template.'
    )
  }
  return contents.replace(POST_INSTALL_CALL, `$1${HOOK}`)
}

function withIosPodDeploymentTarget(config) {
  return withPodfile(config, (cfg) => {
    cfg.modResults.contents = addPodDeploymentTargetHook(cfg.modResults.contents)
    return cfg
  })
}

module.exports = withIosPodDeploymentTarget
module.exports.addPodDeploymentTargetHook = addPodDeploymentTargetHook
