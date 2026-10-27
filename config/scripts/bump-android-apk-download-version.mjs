#!/usr/bin/env node

// Rewrites the marketing site's ANDROID_RELEASE_VERSION, which /download/android and every
// APK link derive from. Usage: bump-android-apk-download-version.mjs <downloadTargets.ts> <x.y.z>

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { compareReleaseTags } from './stable-release-tags.mjs'

const VERSION_LINE = /^(export const ANDROID_RELEASE_VERSION = ")(\d+\.\d+\.\d+)(";)$/m

/** The source pointing at `version`, unchanged when it already names that or a newer one. */
export function bumpAndroidApkDownloadVersion(source, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Android release version must use x.y.z format: ${version}`)
  }
  const match = VERSION_LINE.exec(source)
  if (!match) {
    throw new Error('ANDROID_RELEASE_VERSION declaration not found')
  }
  // Why: rerunning an older release must not walk the download back.
  if (compareReleaseTags(match[2], version) >= 0) {
    return { previousVersion: match[2], source }
  }
  return {
    previousVersion: match[2],
    source: source.replace(VERSION_LINE, `$1${version}$3`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, version] = process.argv.slice(2)
  const before = readFileSync(file, 'utf8')
  const { previousVersion, source } = bumpAndroidApkDownloadVersion(before, version)
  if (source === before) {
    console.log(`Android APK download already at ${previousVersion}; nothing to bump`)
  } else {
    writeFileSync(file, source)
    console.log(`Android APK download bumped ${previousVersion} -> ${version}`)
  }
}
