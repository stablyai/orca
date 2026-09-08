const { withAppBuildGradle } = require('expo/config-plugins')

// Why: android/ is generated and gitignored, so the opt-in has to be reapplied on every prebuild.
const RELEASE_BLOCK = '        release {\n'
const DEBUGGABLE_LINE =
  '            // Dogfood opt-in: -PorcaInspectableRelease=true keeps the release bundle but marks the APK debuggable.\n' +
  "            debuggable = (findProperty('orcaInspectableRelease') ?: 'false').toBoolean()\n"

function addInspectableReleaseOptIn(contents) {
  if (contents.includes('orcaInspectableRelease')) {
    return contents
  }
  if (!contents.includes(RELEASE_BLOCK)) {
    throw new Error('android app/build.gradle has no release buildType block to make inspectable')
  }
  return contents.replace(RELEASE_BLOCK, RELEASE_BLOCK + DEBUGGABLE_LINE)
}

module.exports = function withAndroidInspectableRelease(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = addInspectableReleaseOptIn(cfg.modResults.contents)
    return cfg
  })
}

module.exports.addInspectableReleaseOptIn = addInspectableReleaseOptIn
