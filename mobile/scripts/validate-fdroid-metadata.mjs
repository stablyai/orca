#!/usr/bin/env node

/**
 * Validate (or sync) repo-root F-Droid metadata against mobile/app.json.
 *
 * Usage:
 *   node scripts/validate-fdroid-metadata.mjs
 *   node scripts/validate-fdroid-metadata.mjs --write
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  assertFdroidMetadataAligned,
  parseFdroidMetadataVersionFields,
  readMobileAndroidAppIdentity,
  syncFdroidMetadataVersions
} from './fdroid-app-identity.mjs'

const mobileRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(mobileRoot, '..')

const appConfigPath = process.env.MOBILE_APP_CONFIG_PATH || path.join(mobileRoot, 'app.json')
const metadataPath =
  process.env.FDROID_METADATA_PATH || path.join(repoRoot, 'metadata', 'com.stably.orca.mobile.yml')

const write = process.argv.includes('--write')

const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
const identity = readMobileAndroidAppIdentity(appConfig)

if (identity.packageId !== 'com.stably.orca.mobile') {
  console.error(
    `Unexpected Android package id ${JSON.stringify(identity.packageId)}; expected com.stably.orca.mobile`
  )
  process.exit(1)
}

const originalYaml = fs.readFileSync(metadataPath, 'utf8')
const nextYaml = write ? syncFdroidMetadataVersions(originalYaml, identity) : originalYaml

if (write && nextYaml !== originalYaml) {
  fs.writeFileSync(metadataPath, nextYaml)
  console.log(
    `Updated ${path.relative(repoRoot, metadataPath)} to ${identity.versionName} (${identity.versionCode})`
  )
}

const fields = parseFdroidMetadataVersionFields(nextYaml)
assertFdroidMetadataAligned(identity, fields)

console.log(
  `F-Droid metadata OK: ${identity.packageId} ${identity.versionName} (${identity.versionCode})`
)
