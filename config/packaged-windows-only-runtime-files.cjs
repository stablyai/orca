'use strict'

const { existsSync, readdirSync } = require('node:fs')
const { join, relative } = require('node:path')
const { readPeMachine } = require('./scripts/windows-pe-machine.cjs')

/** Files a runtime package publishes that no desktop package, or only Windows, loads. */
const RUNTIME_PACKAGE_EXCLUDED_FILES = {
  // ssh2 uses pagent.exe only on Windows; C source/build script are build-only everywhere.
  ssh2: {
    everyPlatform: ['util/pagent.c', 'util/build_pagent.bat'],
    nonWindows: ['util/pagent.exe']
  }
}

/** extraResources filter patterns that keep `packageName`'s excluded files out of the copy. */
function runtimePackageExcludeFilter(packageName, electronPlatformName) {
  const excluded = RUNTIME_PACKAGE_EXCLUDED_FILES[packageName]
  if (!excluded) {
    return []
  }
  return [
    ...excluded.everyPlatform,
    ...(electronPlatformName === 'win32' ? [] : excluded.nonWindows)
  ].map((file) => `!${file}`)
}

function collectWindowsExecutables(directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectWindowsExecutables(entryPath, found)
    } else if (entry.isFile() && readPeMachine(entryPath) !== null) {
      found.push(entryPath)
    }
  }
  return found
}

// Inspect content: dependency bumps can add PE files under arbitrary names, and scanners flag them in non-Windows installs.
function assertNoWindowsExecutablesInRuntimeNodeModules(resourcesDir, electronPlatformName) {
  const nodeModulesDir = join(resourcesDir, 'node_modules')
  if (electronPlatformName === 'win32' || !existsSync(nodeModulesDir)) {
    return
  }
  const found = collectWindowsExecutables(nodeModulesDir, [])
  if (found.length > 0) {
    throw new Error(
      `The ${electronPlatformName} package ships Windows executables in node_modules: ` +
        `${found.map((file) => relative(resourcesDir, file).replace(/\\/g, '/')).join(', ')}. ` +
        'Exclude them in config/packaged-windows-only-runtime-files.cjs or prune them after packing.'
    )
  }
}

module.exports = {
  RUNTIME_PACKAGE_EXCLUDED_FILES,
  assertNoWindowsExecutablesInRuntimeNodeModules,
  runtimePackageExcludeFilter
}
