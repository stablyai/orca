import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SNAPSHOT_FILENAME = '.orca-dev-web-inputs.json'
const INPUT_PATHS = ['vite.web.config.ts', 'src/renderer', 'src/shared', 'src/preload/api-types.ts']

const TEST_SOURCE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/

function collectInputs(targetPath, relativePath, files) {
  let stat
  try {
    stat = statSync(targetPath, { bigint: true })
  } catch {
    return 0
  }
  const mtimeMs = Number(stat.mtimeNs) / 1e6
  if (!stat.isDirectory()) {
    files.push([
      relativePath,
      ...[stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino, stat.size].map(String)
    ])
    return mtimeMs
  }
  let latest = mtimeMs
  for (const entry of readdirSync(targetPath, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    if (
      entry.name === 'node_modules' ||
      entry.name.startsWith('.') ||
      (!entry.isDirectory() && TEST_SOURCE_PATTERN.test(entry.name))
    ) {
      continue
    }
    latest = Math.max(
      latest,
      collectInputs(join(targetPath, entry.name), join(relativePath, entry.name), files)
    )
  }
  return latest
}

export function captureDevWebClientInputs(root) {
  const files = []
  const latestMtime = Math.max(
    ...INPUT_PATHS.map((input) => collectInputs(join(root, input), input, files))
  )
  return {
    signature: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    latestMtime
  }
}

function outputIdentity(root) {
  const stat = statSync(join(root, 'out', 'web', 'web-index.html'))
  return [stat.mtimeMs, stat.size]
}

export function recordDevWebClientInputs(root, inputs) {
  try {
    writeFileSync(
      join(root, 'out', 'web', SNAPSHOT_FILENAME),
      JSON.stringify({ version: 1, output: outputIdentity(root), signature: inputs.signature })
    )
  } catch {
    // A missing cache must never prevent dev startup.
  }
}

export function isDevWebClientFresh(root) {
  let output
  try {
    output = outputIdentity(root)
  } catch {
    return false
  }
  if (output[0] === 0) {
    return false
  }
  const inputs = captureDevWebClientInputs(root)
  try {
    const previous = JSON.parse(readFileSync(join(root, 'out', 'web', SNAPSHOT_FILENAME), 'utf8'))
    if (previous.version === 1 && JSON.stringify(previous.output) === JSON.stringify(output)) {
      return previous.signature === inputs.signature
    }
  } catch {
    // Existing standalone and projected builds can be adopted without rebuilding.
  }
  if (inputs.latestMtime > output[0]) {
    return false
  }
  recordDevWebClientInputs(root, inputs)
  return true
}
