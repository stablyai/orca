#!/usr/bin/env node

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { stageWindowsNodePtyPrebuild } = require('../windows-node-pty-prebuild.cjs')

const architecture = readArchitecture(process.argv.slice(2))
const releaseDir = stageWindowsNodePtyPrebuild(process.cwd(), architecture)
console.log(`[rebuild] Staged verified Windows ${architecture} node-pty prebuild -> ${releaseDir}`)

function readArchitecture(args) {
  if (args.length !== 1 || !args[0].startsWith('--arch=')) {
    throw new Error('Usage: stage-windows-node-pty-prebuild.mjs --arch=<x64|arm64>')
  }
  const architecture = args[0].slice('--arch='.length)
  if (!architecture) {
    throw new Error('Missing value for --arch')
  }
  return architecture
}
