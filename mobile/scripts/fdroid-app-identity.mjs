/**
 * Pure helpers for F-Droid metadata ↔ mobile/app.json alignment.
 * No filesystem I/O — callers pass parsed config / YAML text.
 */

const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * @typedef {{
 *   packageId: string
 *   versionName: string
 *   versionCode: number
 *   autoName: string
 * }} MobileAndroidAppIdentity
 */

/**
 * @typedef {{
 *   versionName: string
 *   versionCode: number
 *   currentVersion: string
 *   currentVersionCode: number
 * }} FdroidMetadataVersionFields
 */

/**
 * @param {unknown} appConfig
 * @returns {MobileAndroidAppIdentity}
 */
export function readMobileAndroidAppIdentity(appConfig) {
  if (appConfig == null || typeof appConfig !== 'object') {
    throw new Error('app.json must be a JSON object')
  }

  const expo = /** @type {Record<string, unknown>} */ (appConfig).expo
  if (expo == null || typeof expo !== 'object') {
    throw new Error('app.json is missing expo config')
  }

  const expoConfig = /** @type {Record<string, unknown>} */ (expo)
  const android = expoConfig.android
  if (android == null || typeof android !== 'object') {
    throw new Error('app.json is missing expo.android config')
  }

  const androidConfig = /** @type {Record<string, unknown>} */ (android)
  const packageId = String(androidConfig.package ?? '').trim()
  if (!packageId) {
    throw new Error('app.json is missing expo.android.package')
  }

  const versionName = String(expoConfig.version ?? '').trim()
  if (!SEMVER.test(versionName)) {
    throw new Error(`expo.version must use x.y.z format, got ${JSON.stringify(versionName)}`)
  }

  const versionCode = Number(androidConfig.versionCode)
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error('expo.android.versionCode must be a positive integer')
  }

  const autoName = String(expoConfig.name ?? '').trim() || 'Orca'

  return { packageId, versionName, versionCode, autoName }
}

/**
 * @param {string} metadataYaml
 * @returns {FdroidMetadataVersionFields}
 */
export function parseFdroidMetadataVersionFields(metadataYaml) {
  if (typeof metadataYaml !== 'string' || !metadataYaml.trim()) {
    throw new Error('F-Droid metadata YAML must be a non-empty string')
  }

  // Builds entries are list items: `  - versionName: x.y.z` then indented versionCode.
  const versionName = matchFirst(
    metadataYaml,
    /^\s*(?:-\s*)?versionName:\s*(\S+)\s*$/m,
    'Builds.versionName'
  )
  const versionCode = parsePositiveInt(
    matchFirst(metadataYaml, /^\s*(?:-\s*)?versionCode:\s*(\d+)\s*$/m, 'Builds.versionCode'),
    'Builds.versionCode'
  )
  const currentVersion = matchFirst(metadataYaml, /^CurrentVersion:\s*(\S+)\s*$/m, 'CurrentVersion')
  const currentVersionCode = parsePositiveInt(
    matchFirst(metadataYaml, /^CurrentVersionCode:\s*(\d+)\s*$/m, 'CurrentVersionCode'),
    'CurrentVersionCode'
  )

  return { versionName, versionCode, currentVersion, currentVersionCode }
}

/**
 * @param {MobileAndroidAppIdentity} identity
 * @param {FdroidMetadataVersionFields} fields
 */
export function assertFdroidMetadataAligned(identity, fields) {
  const mismatches = []

  if (fields.versionName !== identity.versionName) {
    mismatches.push(
      `Builds.versionName ${JSON.stringify(fields.versionName)} != app version ${JSON.stringify(identity.versionName)}`
    )
  }
  if (fields.versionCode !== identity.versionCode) {
    mismatches.push(
      `Builds.versionCode ${fields.versionCode} != app versionCode ${identity.versionCode}`
    )
  }
  if (fields.currentVersion !== identity.versionName) {
    mismatches.push(
      `CurrentVersion ${JSON.stringify(fields.currentVersion)} != app version ${JSON.stringify(identity.versionName)}`
    )
  }
  if (fields.currentVersionCode !== identity.versionCode) {
    mismatches.push(
      `CurrentVersionCode ${fields.currentVersionCode} != app versionCode ${identity.versionCode}`
    )
  }

  if (mismatches.length > 0) {
    throw new Error(
      `F-Droid metadata is out of sync with mobile/app.json:\n- ${mismatches.join('\n- ')}`
    )
  }
}

/**
 * Rewrite version fields in metadata YAML to match app identity.
 * Preserves the rest of the file (recipe, descriptions, scanignore, etc.).
 *
 * @param {string} metadataYaml
 * @param {MobileAndroidAppIdentity} identity
 * @returns {string}
 */
export function syncFdroidMetadataVersions(metadataYaml, identity) {
  let next = metadataYaml

  next = replaceAllLineMatches(
    next,
    /^(\s*(?:-\s*)?versionName:\s*)\S+(\s*)$/m,
    `$1${identity.versionName}$2`
  )
  next = replaceAllLineMatches(
    next,
    /^(\s*(?:-\s*)?versionCode:\s*)\d+(\s*)$/m,
    `$1${identity.versionCode}$2`
  )
  next = replaceAllLineMatches(
    next,
    /^(CurrentVersion:\s*)\S+(\s*)$/m,
    `$1${identity.versionName}$2`
  )
  next = replaceAllLineMatches(
    next,
    /^(CurrentVersionCode:\s*)\d+(\s*)$/m,
    `$1${identity.versionCode}$2`
  )

  // Keep the Builds.commit tag aligned with the production Android release tag scheme.
  next = replaceAllLineMatches(
    next,
    /^(\s*(?:-\s*)?commit:\s*)mobile-android-v[\d.]+(\s*)$/m,
    `$1mobile-android-v${identity.versionName}$2`
  )

  assertFdroidMetadataAligned(identity, parseFdroidMetadataVersionFields(next))
  return next
}

/**
 * @param {string} text
 * @param {RegExp} re
 * @param {string} label
 */
function matchFirst(text, re, label) {
  const match = text.match(re)
  if (!match?.[1]) {
    throw new Error(`F-Droid metadata is missing ${label}`)
  }
  return match[1]
}

/**
 * @param {string} raw
 * @param {string} label
 */
function parsePositiveInt(raw, label) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

/**
 * @param {string} text
 * @param {RegExp} re
 * @param {string} replacement
 */
function replaceAllLineMatches(text, re, replacement) {
  const next = text.replace(re, replacement)
  if (next === text) {
    throw new Error(`F-Droid metadata sync failed to update pattern ${re}`)
  }
  return next
}
