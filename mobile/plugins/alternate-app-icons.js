const fs = require('node:fs')
const path = require('node:path')
const {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withXcodeProject
} = require('expo/config-plugins')

// Why: neither OS can switch to an icon that is not compiled into the app, and prebuild
// regenerates ios/ and android/, so the alternate icons are declared here on every prebuild.

const PRIMARY_ICON_NAME = 'AppIcon'
const LAUNCHER_ACTION = 'android.intent.action.MAIN'
const LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER'

// Must match alternateIconNameFor in src/app-icon/app-icon-switcher.ts.
function alternateIconName(iconId) {
  return `${PRIMARY_ICON_NAME}${iconId.charAt(0).toUpperCase()}${iconId.slice(1)}`
}

function androidIconResourceName(iconId) {
  return `app_icon_${iconId}`
}

function writeIosIconSets(assetCatalogDir, projectRoot, icons) {
  for (const [iconId, source] of Object.entries(icons)) {
    const iconSetDir = path.join(assetCatalogDir, `${alternateIconName(iconId)}.appiconset`)
    fs.mkdirSync(iconSetDir, { recursive: true })
    fs.copyFileSync(path.resolve(projectRoot, source), path.join(iconSetDir, 'icon.png'))
    const contents = {
      images: [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { author: 'expo', version: 1 }
    }
    fs.writeFileSync(
      path.join(iconSetDir, 'Contents.json'),
      `${JSON.stringify(contents, null, 2)}\n`
    )
  }
}

function setIosAlternateIconNames(project, icons) {
  const names = Object.keys(icons).map(alternateIconName).join(' ')
  for (const buildConfig of Object.values(project.pbxXCBuildConfigurationSection())) {
    const settings = buildConfig?.buildSettings
    // Only target configurations carry PRODUCT_NAME; project-level ones are skipped.
    if (settings?.PRODUCT_NAME !== undefined) {
      settings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${names}"`
    }
  }
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function writeAndroidIconResources(resDir, projectRoot, icons) {
  for (const [iconId, source] of Object.entries(icons)) {
    const name = androidIconResourceName(iconId)
    const artwork = path.join(resDir, 'drawable-nodpi', `${name}.png`)
    fs.mkdirSync(path.dirname(artwork), { recursive: true })
    fs.copyFileSync(path.resolve(projectRoot, source), artwork)
    // The art is full-bleed, so inset it to the 72dp of the 108dp adaptive layer a launcher shows.
    writeFile(
      path.join(resDir, 'mipmap-anydpi-v26', `${name}.xml`),
      `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/iconBackground"/>
    <foreground>
        <inset android:drawable="@drawable/${name}" android:inset="16.7%"/>
    </foreground>
</adaptive-icon>
`
    )
    // minSdk 24 predates adaptive icons.
    writeFile(
      path.join(resDir, 'mipmap-anydpi', `${name}.xml`),
      `<?xml version="1.0" encoding="utf-8"?>
<bitmap xmlns:android="http://schemas.android.com/apk/res/android" android:src="@drawable/${name}"/>
`
    )
  }
}

function isLauncherIntentFilter(filter) {
  return (
    filter.action?.some((action) => action.$['android:name'] === LAUNCHER_ACTION) &&
    filter.category?.some((category) => category.$['android:name'] === LAUNCHER_CATEGORY)
  )
}

function launcherAlias({ name, targetActivity, enabled, icon, roundIcon }) {
  return {
    $: {
      'android:name': `.${name}`,
      'android:targetActivity': targetActivity,
      'android:enabled': String(enabled),
      'android:exported': 'true',
      'android:icon': icon,
      'android:roundIcon': roundIcon
    },
    'intent-filter': [
      {
        action: [{ $: { 'android:name': LAUNCHER_ACTION } }],
        category: [{ $: { 'android:name': LAUNCHER_CATEGORY } }]
      }
    ]
  }
}

// Android switches icons by enabling one launcher alias of MainActivity and disabling the rest,
// so the launcher entry moves from MainActivity onto an alias per icon.
function setAndroidLauncherAliases(manifest, icons) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)
  const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest)
  const targetActivity = mainActivity.$['android:name']
  mainActivity['intent-filter'] = (mainActivity['intent-filter'] ?? []).filter(
    (filter) => !isLauncherIntentFilter(filter)
  )
  const primary = launcherAlias({
    name: PRIMARY_ICON_NAME,
    targetActivity,
    enabled: true,
    icon: application.$['android:icon'],
    roundIcon: application.$['android:roundIcon']
  })
  const alternates = Object.keys(icons).map((iconId) => {
    const icon = `@mipmap/${androidIconResourceName(iconId)}`
    return launcherAlias({
      name: alternateIconName(iconId),
      targetActivity,
      enabled: false,
      icon,
      roundIcon: icon
    })
  })
  const managedNames = new Set([primary, ...alternates].map((alias) => alias.$['android:name']))
  application['activity-alias'] = [
    ...(application['activity-alias'] ?? []).filter(
      (alias) => !managedNames.has(alias.$['android:name'])
    ),
    primary,
    ...alternates
  ]
  return manifest
}

function withAlternateAppIcons(config, { icons }) {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectRoot } = cfg.modRequest
      const assetCatalogDir = path.join(
        IOSConfig.Paths.getSourceRoot(projectRoot),
        'Images.xcassets'
      )
      writeIosIconSets(assetCatalogDir, projectRoot, icons)
      return cfg
    }
  ])
  config = withXcodeProject(config, (cfg) => {
    setIosAlternateIconNames(cfg.modResults, icons)
    return cfg
  })
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const { platformProjectRoot, projectRoot } = cfg.modRequest
      writeAndroidIconResources(
        path.join(platformProjectRoot, 'app', 'src', 'main', 'res'),
        projectRoot,
        icons
      )
      return cfg
    }
  ])
  return withAndroidManifest(config, (cfg) => {
    setAndroidLauncherAliases(cfg.modResults, icons)
    return cfg
  })
}

module.exports = withAlternateAppIcons
module.exports.alternateIconName = alternateIconName
module.exports.writeIosIconSets = writeIosIconSets
module.exports.setIosAlternateIconNames = setIosAlternateIconNames
module.exports.writeAndroidIconResources = writeAndroidIconResources
module.exports.setAndroidLauncherAliases = setAndroidLauncherAliases
