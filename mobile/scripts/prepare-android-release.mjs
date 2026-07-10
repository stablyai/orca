#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const mobileRoot = path.resolve(import.meta.dirname, '..')
const appConfigPath = process.env.MOBILE_APP_CONFIG_PATH || path.join(mobileRoot, 'app.json')
const androidTagRefPrefix = 'refs/tags/mobile-android-v'
const semverPattern = /^\d+\.\d+\.\d+$/

function input(name) {
  return (process.env[name] || '').trim()
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function validateSemver(version, name) {
  if (!semverPattern.test(version)) {
    fail(`${name} must use x.y.z format`)
  }
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  fs.appendFileSync(outputPath, `${name}=${value}\n`)
}

const config = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
const expo = config.expo || fail('app.json is missing expo config')
const android = expo.android || fail('app.json is missing expo.android config')
const currentVersion = String(expo.version || '').trim()
validateSemver(currentVersion, 'Current mobile version')

const currentVersionCode = Number(android.versionCode)
if (!Number.isSafeInteger(currentVersionCode) || currentVersionCode <= 0) {
  fail('Current Android versionCode must be a positive integer')
}

const githubRef = input('GITHUB_REF')
const tagVersion = githubRef.startsWith(androidTagRefPrefix)
  ? githubRef.slice(androidTagRefPrefix.length)
  : ''
const requestedVersion = input('MOBILE_ANDROID_RELEASE_VERSION')
const bumpPatch = truthy(input('MOBILE_ANDROID_BUMP_PATCH_VERSION'))

if (tagVersion) {
  validateSemver(tagVersion, 'Android release tag version')
}

if (requestedVersion) {
  validateSemver(requestedVersion, 'MOBILE_ANDROID_RELEASE_VERSION')
}

if (bumpPatch) {
  fail('MOBILE_ANDROID_BUMP_PATCH_VERSION is no longer supported; commit mobile/app.json first')
}

if (tagVersion && tagVersion !== currentVersion) {
  fail('Android release tag version must match the committed mobile app version')
}

if (requestedVersion && requestedVersion !== currentVersion) {
  fail('MOBILE_ANDROID_RELEASE_VERSION must match the committed mobile app version')
}

const requestedVersionCode = input('MOBILE_ANDROID_VERSION_CODE')
const bumpVersionCode = truthy(input('MOBILE_ANDROID_BUMP_VERSION_CODE'))

if (requestedVersionCode || bumpVersionCode) {
  // Why: Android rejects lower versionCode installs; release-only bumps leave
  // committed dev builds behind shipped APKs and break local testing.
  fail('Android versionCode changes must be committed in mobile/app.json before release')
}

const tag = `mobile-android-v${currentVersion}`
const publishRelease =
  githubRef.startsWith(androidTagRefPrefix) || truthy(input('MOBILE_ANDROID_PUBLISH_RELEASE'))

writeOutput('version', currentVersion)
writeOutput('android_version_code', String(currentVersionCode))
writeOutput('tag', tag)
writeOutput('publish_release', publishRelease ? 'true' : 'false')

console.log(`Prepared Orca Mobile Android ${currentVersion} (${currentVersionCode})`)
console.log(`Release tag: ${tag}`)
console.log(`Publish GitHub Release: ${publishRelease ? 'yes' : 'no'}`)
