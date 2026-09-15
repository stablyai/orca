const { withAndroidManifest, withMainActivity, AndroidConfig } = require('expo/config-plugins')

// One UI assigns split-window panes a density different from fullscreen
// (e.g. 420 -> 321 dpi). RN's process-global DisplayMetricsHolder keeps the
// density captured at process start, so PixelUtil SP/DP conversions (text
// pipeline, JS didUpdateDimensions) scale against the wrong density after a
// multi-window transition that doesn't recreate the activity.
// react-native-screens >=4.26 frames are already correct (per-view context).
// What: re-seed both holders from the activity's (windowed) resources on
// create/resume/configurationChange, and handle `density` in configChanges
// so the density switch reaches onConfigurationChanged instead of a restart.
// Shares the holder-reseeding approach of the DeX fix (#16018) without the
// DeX-specific manifest meta-data; unlike #16018 the screen holder also
// takes windowed metrics, which the text-measure pipeline requires.

const DISPLAY_METRICS_IMPORTS = [
  'android.content.res.Configuration',
  'com.facebook.react.uimanager.DisplayMetricsHolder'
]

const DISPLAY_METRICS_METHODS = `
  // ORCA_MULTIWINDOW_METRICS
  private fun applyActivityDisplayMetrics() {
    // All PixelUtil conversions read the screen holder; Fabric mounts with the
    // windowed (view-context) density. Seed BOTH from the windowed resources so
    // the pipelines agree — DeviceInfo 'screen'== 'window' in multi-window.
    val windowMetrics = resources.displayMetrics
    DisplayMetricsHolder.setWindowDisplayMetrics(windowMetrics)
    DisplayMetricsHolder.setScreenDisplayMetrics(windowMetrics)
  }

  private fun emitActivityDimensions() {
    reactHost?.currentReactContext?.emitDeviceEvent(
      "didUpdateDimensions",
      DisplayMetricsHolder.getDisplayMetricsWritableMap(
        resources.configuration.fontScale.toDouble()
      )
    )
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyActivityDisplayMetrics()
    window.decorView.requestLayout()
    emitActivityDimensions()
  }

  override fun onResume() {
    super.onResume()
    applyActivityDisplayMetrics()
    emitActivityDimensions()
  }
`

function injectDisplayMetrics(source) {
  if (source.includes('ORCA_MULTIWINDOW_METRICS')) {
    return source
  }

  const missingImports = DISPLAY_METRICS_IMPORTS.filter(
    (importName) => !source.includes(`import ${importName}`)
  )
  if (missingImports.length > 0) {
    source = source.replace(
      /^(package [^\n]+\n)/,
      `$1${missingImports.map((importName) => `import ${importName}`).join('\n')}\n`
    )
  }

  if (!source.includes('super.onCreate(null)')) {
    throw new Error('MainActivity.kt is missing the expected super.onCreate(null) call')
  }
  source = source.replace(
    'super.onCreate(null)',
    `applyActivityDisplayMetrics()
    super.onCreate(null)`
  )

  const classEnd = source.lastIndexOf('\n}')
  if (classEnd === -1) {
    throw new Error('MainActivity.kt is missing its class closing brace')
  }
  return `${source.slice(0, classEnd)}\n${DISPLAY_METRICS_METHODS}${source.slice(classEnd)}`
}

function applyMultiWindowMetricsManifest(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest)
  const current = activity.$['android:configChanges'] || ''
  const changes = current.split('|').filter(Boolean)
  if (!changes.includes('density')) {
    changes.push('density')
  }
  activity.$['android:configChanges'] = changes.join('|')
  return manifest
}

module.exports = function withAndroidMultiWindowMetrics(config) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyMultiWindowMetricsManifest(cfg.modResults)
    return cfg
  })

  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('Multi-window metrics fix requires a Kotlin MainActivity')
    }
    cfg.modResults.contents = injectDisplayMetrics(cfg.modResults.contents)
    return cfg
  })
}

module.exports.injectDisplayMetrics = injectDisplayMetrics
module.exports.applyMultiWindowMetricsManifest = applyMultiWindowMetricsManifest
