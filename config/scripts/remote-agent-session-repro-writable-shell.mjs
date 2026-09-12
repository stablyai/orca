#!/usr/bin/env node

import { appendFileSync } from 'node:fs'

const markerPath = process.argv[2]
if (!markerPath) {
  process.exit(2)
}

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.on('data', (data) => appendFileSync(markerPath, data))
process.stdin.resume()
setInterval(() => {}, 1_000)
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
