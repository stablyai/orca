const { withAndroidManifest, withMainActivity } = require('expo/config-plugins')
const { AndroidConfig } = require('expo/config-plugins')

const CONFIG_CHANGES = [
  'keyboard',
  'keyboardHidden',
  'orientation',
  'screenSize',
  'smallestScreenSize',
  'screenLayout',
  'uiMode',
  'density',
  'locale',
  'layoutDirection',
  'fontScale',
  'navigation',
  'mcc',
  'mnc'
].join('|')

const APPLICATION_METADATA = [
  ['com.samsung.android.keepalive.density', 'true'],
  ['com.samsung.android.multidisplay.keep_process_alive', 'true'],
  ['android.allow_multiple_resumed_activities', 'true']
]

const DISPLAY_METRICS_IMPORTS = [
  'android.content.res.Configuration',
  'android.util.DisplayMetrics',
  'android.view.WindowManager',
  'com.facebook.react.uimanager.DisplayMetricsHolder'
]

const DISPLAY_METRICS_METHODS = `
  // ORCA_DISPLAY_METRICS
  @Suppress("DEPRECATION")
  private fun applyActivityDisplayMetrics() {
    val windowMetrics = resources.displayMetrics
    val screenMetrics = DisplayMetrics()
    (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(screenMetrics)
    screenMetrics.scaledDensity = windowMetrics.scaledDensity
    DisplayMetricsHolder.setWindowDisplayMetrics(windowMetrics)
    DisplayMetricsHolder.setScreenDisplayMetrics(screenMetrics)
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

function upsertNamedEntry(entries, name, value) {
  const next = Array.isArray(entries) ? entries : []
  const existing = next.find((entry) => entry.$?.['android:name'] === name)
  if (existing) {
    existing.$['android:value'] = value
    return next
  }
  next.push({ $: { 'android:name': name, 'android:value': value } })
  return next
}

function applyAndroidDesktopModeManifest(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest)
  activity.$['android:configChanges'] = CONFIG_CHANGES
  activity.$['android:resizeableActivity'] = 'true'
  activity.$['android:supportsPictureInPicture'] = 'false'

  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)
  for (const [name, value] of APPLICATION_METADATA) {
    application['meta-data'] = upsertNamedEntry(application['meta-data'], name, value)
  }
  application.property = upsertNamedEntry(
    application.property,
    'android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES',
    'true'
  )
  return manifest
}

function applyActivityDisplayMetrics(source) {
  if (source.includes('ORCA_DISPLAY_METRICS')) {
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

function withActivityDisplayMetrics(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('Android desktop display metrics require a Kotlin MainActivity')
    }
    cfg.modResults.contents = applyActivityDisplayMetrics(cfg.modResults.contents)
    return cfg
  })
}

const DESKTOP_ORIENTATION_SNIPPET = `super.onCreate(null)
    // ORCA_DESKTOP_ORIENTATION
    val configuration = resources.configuration
    val samsungDesktopMode = try {
      configuration.javaClass.getField("semDesktopModeEnabled").getInt(configuration) == 1
    } catch (_: Exception) { false }
    if ((configuration.uiMode and android.content.res.Configuration.UI_MODE_TYPE_MASK) ==
        android.content.res.Configuration.UI_MODE_TYPE_DESK || samsungDesktopMode) {
      requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }`

function applyDesktopUnspecifiedOrientation(source) {
  if (source.includes('ORCA_DESKTOP_ORIENTATION')) {
    return source
  }
  if (!source.includes('super.onCreate(null)')) {
    throw new Error('MainActivity.kt is missing the expected super.onCreate(null) call')
  }
  return source.replace('super.onCreate(null)', DESKTOP_ORIENTATION_SNIPPET)
}

function withDesktopUnspecifiedOrientation(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('Android desktop orientation hook requires a Kotlin MainActivity')
    }
    cfg.modResults.contents = applyDesktopUnspecifiedOrientation(cfg.modResults.contents)
    return cfg
  })
}

module.exports = function withAndroidDesktopMode(config, options = {}) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyAndroidDesktopModeManifest(cfg.modResults)
    return cfg
  })

  config = withActivityDisplayMetrics(config)

  if (options.desktopUnspecifiedOrientation) {
    config = withDesktopUnspecifiedOrientation(config)
  }
  return config
}

module.exports.applyAndroidDesktopModeManifest = applyAndroidDesktopModeManifest
module.exports.applyActivityDisplayMetrics = applyActivityDisplayMetrics
module.exports.applyDesktopUnspecifiedOrientation = applyDesktopUnspecifiedOrientation
module.exports.CONFIG_CHANGES = CONFIG_CHANGES
