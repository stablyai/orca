#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const FEATURE_WALL_ASSET_DIR = path.join(ROOT, 'resources', 'onboarding', 'feature-wall')
const MAX_BYTES = 11 * 1024 * 1024
const MEDIA_TILE_IDS = [
  'tile-01',
  'tile-02',
  'tile-03',
  'tile-04',
  'tile-05',
  'tile-06',
  'tile-07',
  'tile-08',
  'tile-09',
  'tile-10',
  'tile-11',
  'tile-12'
]
const EXPECTED_FILES = MEDIA_TILE_IDS.flatMap((id) => [
  `${id}.gif`,
  `${id}.poster.jpg`,
  `${id}.recorded-at.json`
])

async function collectFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }

  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

const files = await collectFiles(FEATURE_WALL_ASSET_DIR)
const fileNames = new Set(files.map((file) => path.relative(FEATURE_WALL_ASSET_DIR, file)))
const missingFiles = EXPECTED_FILES.filter((file) => !fileNames.has(file))
if (missingFiles.length > 0) {
  // Why: a byte-budget-only check lets an empty asset directory pass, which
  // ships the feature tour as text-only cards instead of the recorded media.
  console.error(`Feature wall assets are missing: ${missingFiles.join(', ')}`)
  process.exit(1)
}

let totalBytes = 0
for (const file of files) {
  const fileStat = await stat(file)
  totalBytes += fileStat.size
}

if (totalBytes > MAX_BYTES) {
  const totalMb = (totalBytes / 1024 / 1024).toFixed(2)
  const maxMb = (MAX_BYTES / 1024 / 1024).toFixed(2)
  console.error(
    `Feature wall assets are ${totalMb} MB, which exceeds the ${maxMb} MB installer budget.`
  )
  process.exit(1)
}

console.log(
  `Feature wall assets: ${(totalBytes / 1024 / 1024).toFixed(2)} MB / ${(
    MAX_BYTES /
    1024 /
    1024
  ).toFixed(2)} MB`
)
