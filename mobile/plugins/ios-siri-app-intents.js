const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins')

// Siri actions (ORCA_SIRI=1 builds only). Xcode's App Intents metadata processor only reads the app
// target, not static CocoaPods libraries, so the intent declarations are copied into the app target.
// Their logic stays in the OrcaSiri pod (modules/orca-siri/ios), which the copied file imports.
const SOURCE = path.join(__dirname, '..', 'modules', 'orca-siri', 'app-target')
const FILES = ['OrcaAppIntents.swift']

function withSiriSources(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { platformProjectRoot, projectName } = cfg.modRequest
      for (const file of FILES) {
        fs.copyFileSync(path.join(SOURCE, file), path.join(platformProjectRoot, projectName, file))
      }
      return cfg
    }
  ])
}

function withSiriBuildFiles(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const { projectName } = cfg.modRequest
    for (const file of FILES) {
      const filepath = `${projectName}/${file}`
      if (!project.hasFile(filepath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath,
          groupName: projectName,
          project
        })
      }
    }
    return cfg
  })
}

// Expo has no helper to remove a source file from the Xcode project, so switching ORCA_SIRI off needs a
// clean prebuild. Fail loudly instead of building an app that still registers the intents.
function withoutStaleSiriSources(config) {
  return withXcodeProject(config, (cfg) => {
    const { projectName } = cfg.modRequest
    const stale = FILES.filter((file) => cfg.modResults.hasFile(`${projectName}/${file}`))
    if (stale.length > 0) {
      throw new Error(
        `ios/ was generated with ORCA_SIRI=1 and still compiles ${stale.join(', ')}. ` +
          'Run `npx expo prebuild --platform ios --clean` to build without Siri.'
      )
    }
    return cfg
  })
}

module.exports = function withIosSiriAppIntents(config, { enabled } = { enabled: true }) {
  return enabled ? withSiriBuildFiles(withSiriSources(config)) : withoutStaleSiriSources(config)
}
