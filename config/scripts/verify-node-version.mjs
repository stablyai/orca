#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
const requiredMajor = Number(String(packageJson.engines?.node ?? '').match(/\d+/)?.[0])
const actualMajor = Number(process.versions.node.split('.')[0])

if (!requiredMajor || actualMajor === requiredMajor) {
  process.exit(0)
}

console.error(
  `[preflight] Orca requires Node ${requiredMajor}.x, but current Node is ${process.versions.node}.`
)
console.error('[preflight] Switch to Node 24 before installing dependencies or running full tests.')
process.exit(1)
