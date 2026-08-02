#!/usr/bin/env node
// Realigns a source map after a pure deletion was hand-applied to its minified bundle.
//
// Patching a shipped bundle in config/patches/ edits lib/*.js directly, and `mappings`
// encodes generated columns, so leaving it alone makes every segment past the deletion
// resolve that many characters too far along. Rebuilding is not an option: the published
// @xterm/xterm tarball omits bin/, webpack.config.js and tsconfig.json, and a rebuilt
// bundle would differ everywhere the minifier picked other identifiers.
//
//   node config/scripts/shift-sourcemap-after-bundle-edit.mjs \
//     <bundle> <map> <removed-text-file> <preceding-marker-file>
//
// The bundle is read after the edit, so the deletion point is located as the end of the
// unique marker that used to precede the removed text. Segments past the deletion move
// back by its length, segments that pointed into it are dropped because the code they
// named is gone, and every other generated line keeps its original bytes.

import fs from 'node:fs'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGITS = new Map([...BASE64].map((character, index) => [character, index]))

function decodeVlq(text, position) {
  let result = 0
  let shift = 0
  let hasContinuation = true
  const start = position
  while (hasContinuation) {
    const digit = DIGITS.get(text[position++])
    if (digit === undefined) {
      throw new Error(`invalid base64 VLQ digit at ${position - 1}`)
    }
    hasContinuation = (digit & 32) !== 0
    result += (digit & 31) << shift
    shift += 5
  }
  const isNegative = (result & 1) === 1
  result >>= 1
  return { value: isNegative ? -result : result, length: position - start }
}

function encodeVlq(value) {
  let remaining = value < 0 ? (-value << 1) | 1 : value << 1
  let encoded = ''
  do {
    let digit = remaining & 31
    remaining >>>= 5
    if (remaining > 0) {
      digit |= 32
    }
    encoded += BASE64[digit]
  } while (remaining > 0)
  return encoded
}

function decodeSegment(segment) {
  const fields = []
  let position = 0
  while (position < segment.length) {
    const { value, length } = decodeVlq(segment, position)
    fields.push(value)
    position += length
  }
  if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
    throw new Error(`unexpected segment arity ${fields.length}`)
  }
  return fields
}

/** Absolute fields per generated line; only generatedColumn resets between lines. */
function decodeMappings(mappings) {
  const state = { source: 0, sourceLine: 0, sourceColumn: 0, name: 0 }
  return mappings.split(';').map((line) => {
    let generatedColumn = 0
    return line
      .split(',')
      .filter((segment) => segment !== '')
      .map((segment) => {
        const fields = decodeSegment(segment)
        generatedColumn += fields[0]
        const absolute = { generatedColumn }
        if (fields.length >= 4) {
          state.source += fields[1]
          state.sourceLine += fields[2]
          state.sourceColumn += fields[3]
          absolute.source = state.source
          absolute.sourceLine = state.sourceLine
          absolute.sourceColumn = state.sourceColumn
        }
        if (fields.length === 5) {
          state.name += fields[4]
          absolute.name = state.name
        }
        return absolute
      })
  })
}

function encodeLine(segments, incoming) {
  const state = { ...incoming }
  let generatedColumn = 0
  return segments
    .map((segment) => {
      let encoded = encodeVlq(segment.generatedColumn - generatedColumn)
      generatedColumn = segment.generatedColumn
      if (segment.source !== undefined) {
        encoded += encodeVlq(segment.source - state.source)
        encoded += encodeVlq(segment.sourceLine - state.sourceLine)
        encoded += encodeVlq(segment.sourceColumn - state.sourceColumn)
        state.source = segment.source
        state.sourceLine = segment.sourceLine
        state.sourceColumn = segment.sourceColumn
      }
      if (segment.name !== undefined) {
        encoded += encodeVlq(segment.name - state.name)
        state.name = segment.name
      }
      return encoded
    })
    .join(',')
}

function runningStateBefore(lines, lineIndex) {
  const state = { source: 0, sourceLine: 0, sourceColumn: 0, name: 0 }
  for (let index = 0; index < lineIndex; index++) {
    for (const segment of lines[index]) {
      if (segment.source !== undefined) {
        state.source = segment.source
        state.sourceLine = segment.sourceLine
        state.sourceColumn = segment.sourceColumn
      }
      if (segment.name !== undefined) {
        state.name = segment.name
      }
    }
  }
  return state
}

const [bundlePath, mapPath, removedPath, markerPath] = process.argv.slice(2)
if (!bundlePath || !mapPath || !removedPath || !markerPath) {
  console.error(
    'usage: shift-sourcemap-after-bundle-edit.mjs <bundle> <map> <removed-text-file> <preceding-marker-file>'
  )
  process.exit(2)
}

const removed = fs.readFileSync(removedPath, 'utf8')
const marker = fs.readFileSync(markerPath, 'utf8')
const bundle = fs.readFileSync(bundlePath, 'utf8')
const rawMap = fs.readFileSync(mapPath, 'utf8')

// A multi-line deletion would move later generated lines, whose mappings this leaves alone.
if (/[\r\n]/u.test(removed)) {
  throw new Error('removed text must not contain a line terminator')
}
if (bundle.split(marker).length - 1 !== 1) {
  throw new Error('preceding marker is not unique in the bundle')
}
const deleteOffset = bundle.indexOf(marker) + marker.length
const head = bundle.slice(0, deleteOffset)
const generatedLine = (head.match(/\n/g) ?? []).length
const deleteStart = deleteOffset - (head.lastIndexOf('\n') + 1)
const deleteEnd = deleteStart + removed.length

const mappingsMatch = rawMap.match(/"mappings":\s*"([^"]*)"/)
if (!mappingsMatch) {
  throw new Error(`no mappings in ${mapPath}`)
}
const oldMappings = mappingsMatch[1]
const lines = decodeMappings(oldMappings)

const shifted = lines[generatedLine]
  .filter(
    (segment) => segment.generatedColumn < deleteStart || segment.generatedColumn >= deleteEnd
  )
  .map((segment) =>
    segment.generatedColumn >= deleteEnd
      ? { ...segment, generatedColumn: segment.generatedColumn - removed.length }
      : segment
  )

const outgoingBefore = lines[generatedLine].at(-1)
const outgoingAfter = shifted.at(-1)
if (!outgoingBefore || !outgoingAfter) {
  throw new Error(`generated line ${generatedLine} has no segment left to carry running state`)
}
for (const field of ['source', 'sourceLine', 'sourceColumn', 'name']) {
  if (outgoingBefore[field] !== outgoingAfter[field]) {
    throw new Error(`running ${field} changed; later generated lines would shift`)
  }
}

const rawLines = oldMappings.split(';')
rawLines[generatedLine] = encodeLine(shifted, runningStateBefore(lines, generatedLine))
const newMappings = rawLines.join(';')

const decoded = decodeMappings(newMappings)
for (let index = 0; index < lines.length; index++) {
  if (index !== generatedLine && JSON.stringify(lines[index]) !== JSON.stringify(decoded[index])) {
    throw new Error(`generated line ${index} changed`)
  }
}

const lineLength = bundle.split('\n')[generatedLine].length
const maxColumn = Math.max(...shifted.map((segment) => segment.generatedColumn))
const dropped = lines[generatedLine].length - shifted.length
console.log(mapPath)
console.log(`  line ${generatedLine}: removed ${removed.length} chars at column ${deleteStart}`)
console.log(`  segments ${lines[generatedLine].length} -> ${shifted.length} (${dropped} dropped)`)
console.log(`  max mapped column ${maxColumn}, generated line length ${lineLength}`)
if (maxColumn >= lineLength) {
  throw new Error('mappings still overrun the generated line')
}

if (rawMap.split(oldMappings).length - 1 !== 1) {
  throw new Error('mappings string is not unique in the map file')
}
fs.writeFileSync(mapPath, rawMap.replace(oldMappings, newMappings))
console.log('  written')
