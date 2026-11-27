#!/usr/bin/env node
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

buildSwiftCliHelper({
  nativeDir: 'mic-active-status-macos',
  executable: 'orca-mic-active-status',
  argv: process.argv.slice(2)
})
