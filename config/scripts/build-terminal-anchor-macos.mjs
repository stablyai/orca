#!/usr/bin/env node
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

buildSwiftCliHelper({
  nativeDir: 'terminal-anchor-macos',
  executable: 'orca-terminal-anchor',
  argv: process.argv.slice(2)
})
