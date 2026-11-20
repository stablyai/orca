#!/usr/bin/env node
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

buildSwiftCliHelper({
  nativeDir: 'process-footprint-macos',
  executable: 'orca-process-footprint',
  argv: process.argv.slice(2)
})
