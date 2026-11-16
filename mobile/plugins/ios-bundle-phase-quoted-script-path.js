const { withXcodeProject } = require('expo/config-plugins')

// Why: Expo SDK 55's template runs react-native-xcode.sh through an unquoted command substitution,
// so a checkout path with a space splits and "Bundle React Native code and images" fails. Expo's
// SDK 58 template quotes it the same way; drop this plugin then.
const BUNDLE_PHASE_NAME = '"Bundle React Native code and images"'
// The pbxproj keeps shellScript escaped, so quotes appear as \" and newlines as \n.
const SCRIPT_CALL =
  "`\\\"$NODE_BINARY\\\" --print \\\"require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'\\\"`"

module.exports = function withIosBundlePhaseQuotedScriptPath(config) {
  return withXcodeProject(config, (cfg) => {
    const phases = cfg.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {}
    for (const phase of Object.values(phases)) {
      if (typeof phase === 'object' && phase.name === BUNDLE_PHASE_NAME) {
        phase.shellScript = phase.shellScript.replace(
          `\\n${SCRIPT_CALL}\\n`,
          `\\n\\"${SCRIPT_CALL}\\"\\n`
        )
      }
    }
    return cfg
  })
}
