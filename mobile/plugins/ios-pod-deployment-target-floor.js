const { withPodfile } = require('expo/config-plugins')

// Why: Xcode 27 rejects deployment targets below iOS 15.0, and some pods (and their
// resource-bundle targets) still declare 9.0–13.4, which fails the build. The iOS 27 SDK
// is what lets the app resize on iPhone Duo, so raise those targets to the app's own:
// app.json's ios.deploymentTarget, the App Store minimum the paired web page is built for too.
const MARKER = '# orca: pod deployment target floor'
const POST_INSTALL = 'post_install do |installer|'

const floorSnippet = (floor) => `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        target_version = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if target_version && Gem::Version.new(target_version) < Gem::Version.new('${floor}')
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${floor}'
        end
      end
    end`

module.exports = function withIosPodDeploymentTargetFloor(config) {
  const floor = config.ios?.deploymentTarget
  if (typeof floor !== 'string') {
    throw new Error('ios-pod-deployment-target-floor: app.json declares no ios.deploymentTarget')
  }
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents
    if (podfile.includes(MARKER)) {
      return cfg
    }
    if (!podfile.includes(POST_INSTALL)) {
      throw new Error('ios-pod-deployment-target-floor: Podfile has no post_install hook')
    }
    cfg.modResults.contents = podfile.replace(POST_INSTALL, `${POST_INSTALL}${floorSnippet(floor)}`)
    return cfg
  })
}
