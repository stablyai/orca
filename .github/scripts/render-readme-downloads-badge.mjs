import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAgentStateRulesTag } from '../../config/scripts/release-tag-patterns.mjs'

const repository = process.env.GITHUB_REPOSITORY ?? 'stablyai/orca'
const token = process.env.GITHUB_TOKEN
const outputPath = process.env.DOWNLOADS_BADGE_PATH ?? 'docs/assets/readme-downloads.svg'

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'orca-readme-downloads-badge',
  'X-GitHub-Api-Version': '2022-11-28'
}

if (token) {
  headers.Authorization = `Bearer ${token}`
}

async function fetchJson(url) {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

// Why rules releases are excluded: every running app fetches them every few hours, so they
// count fetches, not installs.
export function countReleaseDownloads(releases) {
  let total = 0
  for (const release of releases) {
    if (release.draft || isAgentStateRulesTag(release.tag_name ?? '')) {
      continue
    }

    for (const asset of release.assets ?? []) {
      total += asset.download_count ?? 0
    }
  }
  return total
}

async function getTotalReleaseDownloads() {
  let page = 1
  let total = 0

  while (true) {
    const releases = await fetchJson(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`
    )

    if (releases.length === 0) {
      return total
    }

    total += countReleaseDownloads(releases)
    page += 1
  }
}

function formatDownloads(total) {
  if (total < 1000) {
    return String(total)
  }

  if (total < 1_000_000) {
    return `${Math.round(total / 1000)}k`
  }

  const rounded = total / 1_000_000
  return `${rounded >= 10 ? Math.round(rounded) : rounded.toFixed(1)}m`
}

function textWidth(label) {
  return Math.ceil(label.length * 7.1 + 10)
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function renderBadge(value) {
  const label = 'downloads'
  const leftWidth = textWidth(label)
  const rightWidth = textWidth(value)
  const width = leftWidth + rightWidth
  const labelX = leftWidth / 2
  const valueX = leftWidth + rightWidth / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${width}" height="20" rx="3"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftWidth}" height="20" fill="#555"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="#4c1"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelX}" y="14">${escapeXml(label)}</text>
    <text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${valueX}" y="14">${escapeXml(value)}</text>
  </g>
</svg>
`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const total = await getTotalReleaseDownloads()
  const badge = renderBadge(formatDownloads(total))

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, badge)
  console.log(`Rendered ${outputPath} from ${total} downloads.`)
}
