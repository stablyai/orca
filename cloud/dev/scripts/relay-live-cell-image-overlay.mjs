import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Committed images lag what same-cap rolls serve, and a URL map target pulls every cell's
// template into the plan, so a non-target cell must be planned at the image it serves.
const IMAGE_PATTERN = /^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+\/relay@sha256:[a-f0-9]{64}$/

function liveRelayImage(script, committedImage, cellId) {
  const repository = committedImage.split('@')[0]
  const pulled = [...script.matchAll(/^docker pull '([^']+)'$/gm)]
    .map((match) => match[1])
    .filter((image) => image.split('@')[0] === repository)
  const digest = /^\s*printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '(sha256:[a-f0-9]{64})'$/m.exec(script)?.[1]
  if (pulled.length !== 1 || !IMAGE_PATTERN.test(pulled[0]) || pulled[0].split('@')[1] !== digest) {
    throw new Error(`${cellId} live template has no single pinned Relay image`)
  }
  return pulled[0]
}

export function overlayRelayLiveCellImages({ committedCells, liveTemplates, targetCellIds }) {
  if (!committedCells || Array.isArray(committedCells) || typeof committedCells !== 'object') {
    throw new Error('committed Relay cells must be an object')
  }
  if (!Array.isArray(liveTemplates)) throw new Error('live templates must be an array')
  const targets = new Set(targetCellIds)
  for (const cellId of targets) {
    if (!committedCells[cellId]) throw new Error(`${cellId} is not a committed Relay cell`)
  }
  const scripts = new Map()
  for (const template of liveTemplates) {
    if (typeof template?.index !== 'string' || typeof template.metadata_startup_script !== 'string') {
      throw new Error('live template entry is malformed')
    }
    if (scripts.has(template.index)) throw new Error(`${template.index} has more than one live template`)
    scripts.set(template.index, template.metadata_startup_script)
  }
  const cells = {}
  for (const [cellId, cell] of Object.entries(committedCells)) {
    if (targets.has(cellId)) {
      cells[cellId] = cell
      continue
    }
    const script = scripts.get(cellId)
    // A declared cell with no live template would be created here, outside the reviewed wave.
    if (script === undefined) throw new Error(`${cellId} is not a target and has no live template`)
    cells[cellId] = { ...cell, image: liveRelayImage(script, cell.image, cellId) }
  }
  return { relay_gce_cells: cells }
}

function argumentsFrom(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['cells-json', 'live-templates-json', 'cell-ids', 'output']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  return values
}

function readJsonFile(path, label) {
  const text = readFileSync(path, 'utf8')
  if (!text.trim()) throw new Error(`${label} is empty`)
  return JSON.parse(text)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const values = argumentsFrom(process.argv.slice(2))
  const committedCells = readJsonFile(values['cells-json'], 'committed Relay cells')
  const overlay = overlayRelayLiveCellImages({
    committedCells,
    liveTemplates: readJsonFile(values['live-templates-json'], 'live Relay templates'),
    targetCellIds: values['cell-ids'].split(',').map((value) => value.trim()).filter(Boolean)
  })
  writeFileSync(values.output, `${JSON.stringify(overlay)}\n`)
  const drifted = Object.keys(committedCells).filter(
    (cellId) => overlay.relay_gce_cells[cellId].image !== committedCells[cellId].image
  )
  console.log(JSON.stringify({ cells: Object.keys(committedCells).length, drifted }))
}
