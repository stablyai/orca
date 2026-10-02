const { withMainActivity } = require('expo/config-plugins')

const MARKER = '// ORCA_ACTIVITY_DISPLAY_DENSITY'
const IMPORT = 'import com.facebook.react.uimanager.DisplayMetricsHolder'
const METHODS = `
  ${MARKER}
  private fun syncActivityDisplayDensity() {
    DisplayMetricsHolder.initDisplayMetrics(this)
    reactHost?.currentReactContext?.emitDeviceEvent(
      "didUpdateDimensions",
      DisplayMetricsHolder.getDisplayMetricsWritableMap(
        resources.configuration.fontScale.toDouble()
      )
    )
    window.decorView.requestLayout()
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    syncActivityDisplayDensity()
  }

  override fun onResume() {
    super.onResume()
    syncActivityDisplayDensity()
  }
`

function applyActivityDisplayDensity(source) {
  if (source.includes(MARKER)) {
    return source
  }
  if (/override\s+fun\s+(onConfigurationChanged|onResume)\s*\(/.test(source)) {
    throw new Error('Display density plugin needs existing Activity lifecycle overrides integrated')
  }
  const anchor = 'super.onCreate(null)'
  if (source.split(anchor).length !== 2 || !/^package [^\r\n]+/m.test(source)) {
    throw new Error('Display density plugin requires the Expo Kotlin MainActivity template')
  }
  const classEnd = source.lastIndexOf('}')
  if (classEnd < source.indexOf(anchor)) {
    throw new Error('MainActivity class closing brace missing')
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  source = `${source.slice(0, classEnd)}${METHODS.replaceAll('\n', eol)}${source.slice(classEnd)}`
  if (!source.includes(IMPORT)) {
    source = source.replace(/^(package [^\r\n]+)/m, `$1${eol}${IMPORT}`)
  }
  // RN can overwrite its global metrics while creating the root view.
  return source.replace(
    anchor,
    `DisplayMetricsHolder.initDisplayMetrics(this)${eol}    ${anchor}${eol}    syncActivityDisplayDensity()`
  )
}

module.exports = function withAndroidDisplayDensity(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('Display density plugin requires a Kotlin MainActivity')
    }
    cfg.modResults.contents = applyActivityDisplayDensity(cfg.modResults.contents)
    return cfg
  })
}
module.exports.applyActivityDisplayDensity = applyActivityDisplayDensity
