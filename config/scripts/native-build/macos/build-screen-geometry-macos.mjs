#!/usr/bin/env node
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

buildSwiftCliHelper({
  nativeDir: 'screen-geometry-macos',
  executable: 'orca-screen-geometry',
  argv: process.argv.slice(2)
})
