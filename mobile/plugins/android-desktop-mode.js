const { AndroidConfig, withAndroidManifest, withMainActivity } = require('expo/config-plugins')

const REQUIRED_CONFIG_CHANGES = ['density', 'smallestScreenSize']
const APPLICATION_METADATA = [
  ['com.samsung.android.keepalive.density', 'true'],
  ['com.samsung.android.multidisplay.keep_process_alive', 'true'],
  ['android.allow_multiple_resumed_activities', 'true']
]

function upsertNamedEntry(entries, name, value) {
  const next = Array.isArray(entries) ? entries : []
  const existing = next.find((entry) => entry.$?.['android:name'] === name)
  if (existing) {
    existing.$['android:value'] = value
  } else {
    next.push({ $: { 'android:name': name, 'android:value': value } })
  }
  return next
}

function applyAndroidDesktopModeManifest(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest)
  const configChanges = new Set(
    (activity.$['android:configChanges'] || '').split('|').filter(Boolean)
  )
  for (const change of REQUIRED_CONFIG_CHANGES) {
    configChanges.add(change)
  }
  activity.$['android:configChanges'] = [...configChanges].join('|')
  activity.$['android:resizeableActivity'] = 'true'

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
  const imports = [
    'android.content.res.Configuration',
    'android.view.WindowManager',
    'com.facebook.react.uimanager.DisplayMetricsHolder'
  ].filter((name) => !source.includes(`import ${name}`))
  if (imports.length > 0) {
    source = source.replace(
      /^(package [^\n]+\n)/,
      `$1${imports.map((name) => `import ${name}`).join('\n')}\n`
    )
  }
  if (!source.includes('super.onCreate(null)')) {
    throw new Error('MainActivity.kt is missing the expected super.onCreate(null) call')
  }
  source = source.replace(
    'super.onCreate(null)',
    'applyActivityDisplayMetrics()\n    super.onCreate(null)'
  )
  const classEnd = source.lastIndexOf('\n}')
  if (classEnd === -1) {
    throw new Error('MainActivity.kt is missing its class closing brace')
  }
  return `${source.slice(0, classEnd)}

  // ORCA_DISPLAY_METRICS
  // Keep React Native's density conversions on the display hosting this Activity.
  @Suppress("DEPRECATION")
  private fun applyActivityDisplayMetrics() {
    val windowMetrics = resources.displayMetrics
    val screenMetrics = android.util.DisplayMetrics()
    (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(screenMetrics)
    screenMetrics.scaledDensity = windowMetrics.scaledDensity
    DisplayMetricsHolder.setWindowDisplayMetrics(windowMetrics)
    DisplayMetricsHolder.setScreenDisplayMetrics(screenMetrics)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyActivityDisplayMetrics()
    window.decorView.requestLayout()
    emitActivityDimensions()
  }

  private fun emitActivityDimensions() {
    reactHost?.currentReactContext?.emitDeviceEvent(
      "didUpdateDimensions",
      DisplayMetricsHolder.getDisplayMetricsWritableMap(resources.configuration.fontScale.toDouble())
    )
  }

  override fun onResume() {
    super.onResume()
    applyActivityDisplayMetrics()
    emitActivityDimensions()
  }
${source.slice(classEnd)}`
}

module.exports = function withAndroidDesktopMode(config) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyAndroidDesktopModeManifest(cfg.modResults)
    return cfg
  })
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('Android desktop display metrics require a Kotlin MainActivity')
    }
    cfg.modResults.contents = applyActivityDisplayMetrics(cfg.modResults.contents)
    return cfg
  })
}

module.exports.applyAndroidDesktopModeManifest = applyAndroidDesktopModeManifest
module.exports.applyActivityDisplayMetrics = applyActivityDisplayMetrics
