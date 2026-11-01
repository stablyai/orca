const { withMainActivity } = require('expo/config-plugins')

const MARKER = 'orca-share-intent-replay-guard'
const SUPER_ON_CREATE = 'super.onCreate('

// Recents and restored activities replay the original ACTION_SEND; expo-sharing would read it again as a new share.
const GUARD = `    // ${MARKER}: Recents and state restores replay the original share; only a fresh delivery is a new share.
    if ((savedInstanceState != null || (intent.flags and android.content.Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) &&
      (intent.action == android.content.Intent.ACTION_SEND || intent.action == android.content.Intent.ACTION_SEND_MULTIPLE)) {
      intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
    }
`

function addShareIntentReplayGuard(contents) {
  if (contents.includes(MARKER)) {
    return contents
  }
  const index = contents.indexOf(SUPER_ON_CREATE)
  if (index === -1) {
    throw new Error('android-share-intent-replay-guard: MainActivity has no super.onCreate call')
  }
  const lineStart = contents.lastIndexOf('\n', index) + 1
  return contents.slice(0, lineStart) + GUARD + contents.slice(lineStart)
}

module.exports = function withAndroidShareIntentReplayGuard(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('android-share-intent-replay-guard: expected a Kotlin MainActivity')
    }
    cfg.modResults.contents = addShareIntentReplayGuard(cfg.modResults.contents)
    return cfg
  })
}
module.exports.addShareIntentReplayGuard = addShareIntentReplayGuard
