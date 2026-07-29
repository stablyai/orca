#!/usr/bin/env node

/**
 * FOSS Android build prep used by the in-repo F-Droid recipe.
 * Mirrors .github/workflows/mobile-android-release.yml:
 *   pnpm install → expo prebuild → (strip Play/release signing) → gradle assembleRelease
 *
 * Usage (from mobile/):
 *   node scripts/prepare-fdroid-android-build.mjs
 *
 * Env:
 *   MOBILE_ROOT — override mobile package root (tests)
 *   SKIP_EXPO_PREBUILD=1 — only apply package/signing patches
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * @param {Record<string, unknown>} packageJson
 * @returns {Record<string, unknown>}
 */
export function ensureExpoBuildFromSource(packageJson) {
  const next = { ...packageJson }
  const expo = typeof next.expo === 'object' && next.expo != null ? { ...next.expo } : {}
  const autolinking =
    typeof expo.autolinking === 'object' && expo.autolinking != null ? { ...expo.autolinking } : {}
  const android =
    typeof autolinking.android === 'object' && autolinking.android != null
      ? { ...autolinking.android }
      : {}

  // Prefer compiling RN/Expo Android modules from source on F-Droid builders.
  android.buildFromSource = ['.*']
  autolinking.android = android
  expo.autolinking = autolinking
  next.expo = expo
  return next
}

/**
 * @param {string} gradleText
 */
export function stripReleaseSigningConfig(gradleText) {
  // F-Droid re-signs APKs; drop app signingConfig lines so assembleRelease does not
  // require a private keystore (same pattern as other Expo apps in fdroiddata).
  return gradleText
    .split('\n')
    .filter((line) => !/^\s*signingConfig\s+/.test(line))
    .join('\n')
}

/**
 * @param {{ mobileRoot?: string, skipExpoPrebuild?: boolean }} [options]
 */
export function prepareFdroidAndroidBuild(options = {}) {
  const mobileRoot = path.resolve(
    options.mobileRoot || process.env.MOBILE_ROOT || path.join(import.meta.dirname, '..')
  )
  const skipExpoPrebuild = options.skipExpoPrebuild ?? process.env.SKIP_EXPO_PREBUILD === '1'
  const packageJsonPath = path.join(mobileRoot, 'package.json')
  const androidAppGradlePath = path.join(mobileRoot, 'android', 'app', 'build.gradle')

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const patchedPackageJson = ensureExpoBuildFromSource(packageJson)
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(patchedPackageJson, null, 2)}\n`)
  console.log('Patched package.json expo.autolinking.android.buildFromSource')

  if (!skipExpoPrebuild) {
    execFileSync('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], {
      cwd: mobileRoot,
      stdio: 'inherit',
      env: process.env
    })
  }

  if (fs.existsSync(androidAppGradlePath)) {
    const original = fs.readFileSync(androidAppGradlePath, 'utf8')
    const stripped = stripReleaseSigningConfig(original)
    if (stripped !== original) {
      fs.writeFileSync(androidAppGradlePath, stripped)
      console.log('Removed signingConfig lines from android/app/build.gradle')
    } else {
      console.log('No signingConfig lines to strip in android/app/build.gradle')
    }
  } else if (!skipExpoPrebuild) {
    throw new Error(`Expected ${androidAppGradlePath} after expo prebuild`)
  }

  console.log('F-Droid Android prep complete')
}

const isMain =
  process.argv[1] != null && path.resolve(import.meta.filename) === path.resolve(process.argv[1])

if (isMain) {
  try {
    prepareFdroidAndroidBuild()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
