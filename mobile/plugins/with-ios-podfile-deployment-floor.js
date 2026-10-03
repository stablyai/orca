const { withDangerousMod } = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// Why: Xcode 27 rejects pod deployment targets below 15.0 (several pods declare
// 9.0–13.4), and ExpoRouter 55.0.18 uses an unguarded iOS 16 API so it needs
// 16.0. Only raise — never lower a pod's own minimum.
const MARKER = '# orca: ios-deployment-floor (Xcode 27)'
const HOOK = `${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if Gem::Version.new(current.to_s) < Gem::Version.new('16.0')
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
        end
      end
    end`

function withIosPodfileDeploymentFloor(config) {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const filepath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile')
      const podfile = fs.readFileSync(filepath, 'utf8')
      if (podfile.includes(MARKER)) {
        return cfg
      }
      // Insert inside post_install, before the block that closes it and the file.
      const closeIndex = podfile.lastIndexOf('\n  end\nend')
      if (closeIndex === -1) {
        throw new Error('Podfile structure changed; cannot apply deployment floor hook')
      }
      fs.writeFileSync(
        filepath,
        podfile.slice(0, closeIndex) + '\n' + HOOK + '\n' + podfile.slice(closeIndex)
      )
      return cfg
    }
  ])
  return config
}

module.exports = withIosPodfileDeploymentFloor
