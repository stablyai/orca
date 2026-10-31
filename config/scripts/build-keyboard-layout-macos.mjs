#!/usr/bin/env node
import { buildSwiftCliHelper } from './swift-cli-helper-macos.mjs'

buildSwiftCliHelper({
  nativeDir: 'keyboard-layout-macos',
  executable: 'orca-keyboard-layout',
  additionalSources: ['QuitChordWatch.swift'],
  argv: process.argv.slice(2)
})
