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

function parsePositiveInteger(value, name) {
  if (!/^\d+$/.test(value)) {
    fail(`${name} must be a positive integer`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${name} must be a positive integer`)
  }

  return parsed
}

function validateSemver(version, name) {
  if (!semverPattern.test(version)) {
    fail(`${name} must use x.y.z format`)
  }
}

function bumpPatchVersion(version) {
  validateSemver(version, 'Current mobile version')
  const [major, minor, patch] = version.split('.')
  return `${major}.${minor}.${Number(patch) + 1}`
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

if (requestedVersion && bumpPatch) {
  fail('Use either MOBILE_ANDROID_RELEASE_VERSION or MOBILE_ANDROID_BUMP_PATCH_VERSION, not both')
}

if (tagVersion) {
  validateSemver(tagVersion, 'Android release tag version')
}

if (requestedVersion) {
  validateSemver(requestedVersion, 'MOBILE_ANDROID_RELEASE_VERSION')
}

if (tagVersion && requestedVersion && requestedVersion !== tagVersion) {
  fail('MOBILE_ANDROID_RELEASE_VERSION must match the mobile-android-v tag')
}

if (tagVersion && bumpPatch) {
  fail('MOBILE_ANDROID_BUMP_PATCH_VERSION is only supported for manual branch runs')
}

const version =
  requestedVersion || tagVersion || (bumpPatch ? bumpPatchVersion(currentVersion) : currentVersion)

const requestedVersionCode = input('MOBILE_ANDROID_VERSION_CODE')
const bumpVersionCode = truthy(input('MOBILE_ANDROID_BUMP_VERSION_CODE'))

if (requestedVersionCode && bumpVersionCode) {
  fail('Use either MOBILE_ANDROID_VERSION_CODE or MOBILE_ANDROID_BUMP_VERSION_CODE, not both')
}

const versionCode = requestedVersionCode
  ? parsePositiveInteger(requestedVersionCode, 'MOBILE_ANDROID_VERSION_CODE')
  : bumpVersionCode || version !== currentVersion
    ? currentVersionCode + 1
    : currentVersionCode

expo.version = version
android.versionCode = versionCode
fs.writeFileSync(appConfigPath, `${JSON.stringify(config, null, 2)}\n`)

const tag = `mobile-android-v${version}`
const publishRelease =
  githubRef.startsWith(androidTagRefPrefix) || truthy(input('MOBILE_ANDROID_PUBLISH_RELEASE'))

writeOutput('version', version)
writeOutput('android_version_code', String(versionCode))
writeOutput('tag', tag)
writeOutput('publish_release', publishRelease ? 'true' : 'false')

console.log(`Prepared Orca Mobile Android ${version} (${versionCode})`)
console.log(`Release tag: ${tag}`)
console.log(`Publish GitHub Release: ${publishRelease ? 'yes' : 'no'}`)
