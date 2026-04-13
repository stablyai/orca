#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'

function stripSingleQuotes(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseScalarValue(rawValue) {
  const trimmed = rawValue.trim()
  const isQuoted = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2
  const value = isQuoted ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed

  if (isQuoted) {
    return value
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value)
  }
  return value
}

function finalizeFileRecord(currentFile, sourcePath, lineNumber) {
  if (currentFile == null) {
    return null
  }

  if (
    typeof currentFile.url !== 'string' ||
    typeof currentFile.sha512 !== 'string' ||
    typeof currentFile.size !== 'number'
  ) {
    throw new Error(
      `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: incomplete file entry.`
    )
  }

  return {
    url: currentFile.url,
    sha512: currentFile.sha512,
    size: currentFile.size
  }
}

function parseMacUpdateManifest(raw, sourcePath) {
  const lines = raw.split(/\r?\n/)
  const files = []
  const extras = {}
  let version = null
  let releaseDate = null
  let inFiles = false
  let currentFile = null

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1
    const line = rawLine.trimEnd()
    if (line.length === 0) {
      continue
    }

    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/)
    if (fileUrlMatch?.[1]) {
      const finalized = finalizeFileRecord(currentFile, sourcePath, lineNumber)
      if (finalized) {
        files.push(finalized)
      }
      currentFile = { url: stripSingleQuotes(fileUrlMatch[1].trim()) }
      inFiles = true
      continue
    }

    const fileShaMatch = line.match(/^    sha512:\s*(.+)$/)
    if (fileShaMatch?.[1]) {
      if (currentFile == null) {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: sha512 without a file entry.`
        )
      }
      currentFile.sha512 = stripSingleQuotes(fileShaMatch[1].trim())
      continue
    }

    const fileSizeMatch = line.match(/^    size:\s*(\d+)$/)
    if (fileSizeMatch?.[1]) {
      if (currentFile == null) {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: size without a file entry.`
        )
      }
      currentFile.size = Number(fileSizeMatch[1])
      continue
    }

    if (line === 'files:') {
      inFiles = true
      continue
    }

    if (inFiles && currentFile != null) {
      const finalized = finalizeFileRecord(currentFile, sourcePath, lineNumber)
      if (finalized) {
        files.push(finalized)
      }
      currentFile = null
    }
    inFiles = false

    const topLevelMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/)
    if (!topLevelMatch?.[1] || topLevelMatch[2] === undefined) {
      throw new Error(
        `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: unsupported line '${line}'.`
      )
    }

    const [, key, rawValue] = topLevelMatch
    const value = parseScalarValue(rawValue)

    if (key === 'version') {
      if (typeof value !== 'string') {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: version must be a string.`
        )
      }
      version = value
      continue
    }

    if (key === 'releaseDate') {
      if (typeof value !== 'string') {
        throw new Error(
          `Invalid macOS update manifest at ${sourcePath}:${lineNumber}: releaseDate must be a string.`
        )
      }
      releaseDate = value
      continue
    }

    if (key === 'path' || key === 'sha512') {
      // Why: electron-updater only needs the expanded files[] entries to decide
      // which mac ZIP to fetch for the current architecture. We intentionally
      // drop the single-file legacy fields because keeping one arch-specific
      // path here would make the merged manifest lie about the other arch.
      continue
    }

    extras[key] = value
  }

  const finalized = finalizeFileRecord(currentFile, sourcePath, lines.length)
  if (finalized) {
    files.push(finalized)
  }

  if (!version) {
    throw new Error(`Invalid macOS update manifest at ${sourcePath}: missing version.`)
  }
  if (!releaseDate) {
    throw new Error(`Invalid macOS update manifest at ${sourcePath}: missing releaseDate.`)
  }
  if (files.length === 0) {
    throw new Error(`Invalid macOS update manifest at ${sourcePath}: missing files.`)
  }

  return {
    version,
    releaseDate,
    files,
    extras
  }
}

function mergeExtras(primary, secondary) {
  const merged = { ...primary }

  for (const [key, value] of Object.entries(secondary)) {
    const existing = merged[key]
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Cannot merge macOS update manifests: conflicting '${key}' values ('${existing}' vs '${value}').`
      )
    }
    merged[key] = value
  }

  return merged
}

function mergeMacUpdateManifests(primary, secondary) {
  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge macOS update manifests with different versions (${primary.version} vs ${secondary.version}).`
    )
  }

  const filesByUrl = new Map()
  for (const file of [...primary.files, ...secondary.files]) {
    const existing = filesByUrl.get(file.url)
    if (existing && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
      throw new Error(
        `Cannot merge macOS update manifests: conflicting file entry for ${file.url}.`
      )
    }
    filesByUrl.set(file.url, file)
  }

  return {
    version: primary.version,
    releaseDate:
      primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...filesByUrl.values()],
    extras: mergeExtras(primary.extras, secondary.extras)
  }
}

function quoteYamlString(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function serializeScalarValue(value) {
  if (typeof value === 'string') {
    return quoteYamlString(value)
  }
  return String(value)
}

function serializeMacUpdateManifest(manifest) {
  const lines = [`version: ${manifest.version}`, 'files:']

  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`)
    lines.push(`    sha512: ${file.sha512}`)
    lines.push(`    size: ${file.size}`)
  }

  for (const [key, value] of Object.entries(manifest.extras)) {
    lines.push(`${key}: ${serializeScalarValue(value)}`)
  }

  lines.push(`releaseDate: ${quoteYamlString(manifest.releaseDate)}`)
  lines.push('')

  return lines.join('\n')
}

function main() {
  const [primaryPath, secondaryPath, outputPath = primaryPath] = process.argv.slice(2)

  if (!primaryPath || !secondaryPath) {
    console.error(
      'Usage: node config/scripts/merge-mac-update-manifests.mjs <latest-mac.yml> <latest-mac-x64.yml> [output-path]'
    )
    process.exit(1)
  }

  const primary = parseMacUpdateManifest(readFileSync(primaryPath, 'utf8'), primaryPath)
  const secondary = parseMacUpdateManifest(readFileSync(secondaryPath, 'utf8'), secondaryPath)
  const merged = mergeMacUpdateManifests(primary, secondary)

  writeFileSync(outputPath, serializeMacUpdateManifest(merged))
}

main()
