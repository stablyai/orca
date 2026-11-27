#!/usr/bin/env node
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

buildSwiftCliHelper({
  nativeDir: 'socket-owner-macos',
  executable: 'orca-socket-owner',
  argv: process.argv.slice(2)
})
