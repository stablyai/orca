#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'

// Why: the status bar changes between runs, so it cannot distinguish a client
// difference from a second passing on the clock.
const VOLATILE_LABEL =
  /^(\d{1,2}:\d{2}\s?(AM|PM)|Dynamic Island.*|Cellular|SSID.*|\d+% battery power|Not charging|Charging|No signal|\d of \d Wi-Fi bars)$/

function readCapture(file) {
  const capture = JSON.parse(readFileSync(file, 'utf8'))
  return { capture, stops: new Map(capture.stops.map((stop) => [stop.name, stop])) }
}

function normalize(labels, workspace) {
  return labels
    .filter((label) => typeof label === 'string' && label.length > 0)
    .filter((label) => !VOLATILE_LABEL.test(label))
    .map((label) => label.replaceAll(workspace, '<workspace>'))
}

function diffStop(name, left, right, leftWorkspace, rightWorkspace) {
  if (!left || !right) {
    return [`${name}: only captured on ${left ? 'the first' : 'the second'} client`]
  }
  const a = normalize(left.labels, leftWorkspace)
  const b = normalize(right.labels, rightWorkspace)
  const lines = []
  for (const label of new Set(a.filter((label) => !b.includes(label)))) {
    lines.push(`${name}: only on the first client: ${label}`)
  }
  for (const label of new Set(b.filter((label) => !a.includes(label)))) {
    lines.push(`${name}: only on the second client: ${label}`)
  }
  if (lines.length === 0 && a.join(' ') !== b.join(' ')) {
    lines.push(`${name}: same label set in a different order`)
  }
  return lines
}

const [leftFile, rightFile] = process.argv.slice(2)
if (!leftFile || !rightFile) {
  throw new Error(
    'Usage: node scripts/diff-hosted-ios-native-journey-capture.mjs <a.json> <b.json>'
  )
}
const left = readCapture(leftFile)
const right = readCapture(rightFile)
const names = [...new Set([...left.stops.keys(), ...right.stops.keys()])]
const differences = names.flatMap((name) =>
  diffStop(
    name,
    left.stops.get(name),
    right.stops.get(name),
    left.capture.expectedWorkspace,
    right.capture.expectedWorkspace
  )
)
console.log(
  JSON.stringify({ stops: names, differenceCount: differences.length, differences }, null, 2)
)
process.exitCode = differences.length === 0 ? 0 : 1
