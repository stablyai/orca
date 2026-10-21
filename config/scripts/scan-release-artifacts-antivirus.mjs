#!/usr/bin/env node
/**
 * Report the current antivirus detection state of built release artifacts, so an
 * RC can be checked before users meet the verdict in an issue report. See
 * docs/reference/antivirus-prerelease-clearance.md.
 *
 * Hash lookup only by default: nothing leaves the machine but a SHA-256. The
 * `--upload` flag transmits the artifact itself, which distributes it to partner
 * vendors — intended for clearance work, never for an automated path.
 */

import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const VIRUSTOTAL_FILES_ENDPOINT = 'https://www.virustotal.com/api/v3/files'

export async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * The engines that call an artifact malicious or suspicious. Every other
 * category (undetected, type-unsupported, timeout, failure) is silence, not a
 * clean bill of health, so it is counted but never reported as a verdict.
 */
export function summarizeEngineVerdicts(analysisResults) {
  const flagged = []
  let scanned = 0
  for (const [engine, result] of Object.entries(analysisResults ?? {})) {
    scanned += 1
    if (result?.category === 'malicious' || result?.category === 'suspicious') {
      flagged.push({
        engine,
        category: result.category,
        detection: result.result ?? '<unnamed>'
      })
    }
  }
  flagged.sort((left, right) => left.engine.localeCompare(right.engine))
  return { scanned, flagged }
}

export function formatArtifactReport({ name, sha256, known, scanned, flagged }) {
  if (!known) {
    return `${name}\n  sha256 ${sha256}\n  no report yet — this build has never been scanned`
  }
  if (flagged.length === 0) {
    return `${name}\n  sha256 ${sha256}\n  clean across ${scanned} engines`
  }
  const lines = flagged.map(
    (entry) => `    ${entry.category.padEnd(10)} ${entry.engine}: ${entry.detection}`
  )
  return [
    name,
    `  sha256 ${sha256}`,
    `  ${flagged.length} of ${scanned} engines flag this build:`,
    ...lines
  ].join('\n')
}

/** True when any artifact carries a verdict a user could hit. */
export function hasAnyDetection(reports) {
  return reports.some((report) => report.flagged.length > 0)
}

async function fetchExistingReport(sha256, apiKey) {
  const response = await fetch(`${VIRUSTOTAL_FILES_ENDPOINT}/${sha256}`, {
    headers: { 'x-apikey': apiKey }
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`VirusTotal lookup failed for ${sha256}: ${response.status}`)
  }
  const body = await response.json()
  return body?.data?.attributes?.last_analysis_results ?? {}
}

// Why a separate upload URL above 32MB: the direct endpoint rejects larger
// files, and every Orca installer is far past that.
async function uploadArtifact(filePath, apiKey) {
  const { size } = await stat(filePath)
  let endpoint = VIRUSTOTAL_FILES_ENDPOINT
  if (size > 32 * 1024 * 1024) {
    const urlResponse = await fetch(`${VIRUSTOTAL_FILES_ENDPOINT}/upload_url`, {
      headers: { 'x-apikey': apiKey }
    })
    if (!urlResponse.ok) {
      throw new Error(`Could not obtain a VirusTotal upload URL: ${urlResponse.status}`)
    }
    endpoint = (await urlResponse.json())?.data
  }
  // openAsBlob streams from disk; buffering a 200MB installer would not fit.
  const form = new FormData()
  form.append('file', await openAsBlob(filePath), basename(filePath))
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-apikey': apiKey },
    body: form
  })
  if (!response.ok) {
    throw new Error(`VirusTotal upload failed for ${filePath}: ${response.status}`)
  }
}

export async function scanArtifacts(filePaths, { apiKey, upload = false } = {}) {
  const reports = []
  for (const filePath of filePaths) {
    const sha256 = await hashFile(filePath)
    let analysisResults = await fetchExistingReport(sha256, apiKey)
    if (analysisResults === null && upload) {
      await uploadArtifact(filePath, apiKey)
      analysisResults = null
    }
    const { scanned, flagged } = summarizeEngineVerdicts(analysisResults)
    reports.push({
      name: basename(filePath),
      sha256,
      known: analysisResults !== null,
      scanned,
      flagged
    })
  }
  return reports
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const upload = args.includes('--upload')
  const filePaths = args.filter((arg) => !arg.startsWith('--'))
  if (filePaths.length === 0) {
    throw new Error(
      'Usage: node config/scripts/scan-release-artifacts-antivirus.mjs [--upload] <artifact>...'
    )
  }
  const apiKey = process.env.VIRUSTOTAL_API_KEY
  if (!apiKey) {
    // Why not a failure: this runs alongside release steps that must not break
    // before the secret is provisioned.
    console.log('VIRUSTOTAL_API_KEY is not set; skipping the antivirus detection report.')
    process.exit(0)
  }

  const reports = await scanArtifacts(filePaths, { apiKey, upload })
  for (const report of reports) {
    console.log(formatArtifactReport(report))
  }
  if (hasAnyDetection(reports)) {
    // Why a warning and not an exit code: these are third-party ML classifiers,
    // so a hard gate hands them the power to fail our releases. A human decides.
    console.log(
      '\nAt least one engine flags a shipped artifact. Decide before publishing, and submit ' +
        'for clearance per docs/reference/antivirus-prerelease-clearance.md.'
    )
  }
}
