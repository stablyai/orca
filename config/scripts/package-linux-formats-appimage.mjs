import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'

const require = createRequire(import.meta.url)

async function getPinnedTools(version) {
  const { getAppImageTools } = require('app-builder-lib/out/toolsets/linux.js')
  return getAppImageTools(version, require('builder-util').Arch.x64)
}

export async function preparePrAppImageTools({
  directory: requestedDirectory,
  configuration = require('../electron-builder-pr-linux.config.cjs'),
  getTools = getPinnedTools,
  platform = process.platform,
  architecture = process.arch
}) {
  if (platform !== 'linux' || architecture !== 'x64') {
    throw new Error('PR AppImage compression requires a Linux x64 host')
  }
  if (configuration.toolsets?.appimage !== '1.0.3') {
    throw new Error('PR AppImage compression requires pinned AppImage toolset 1.0.3')
  }
  if (
    configuration.compression === 'store' ||
    (configuration.appImage?.compression && configuration.appImage.compression !== 'zstd')
  ) {
    throw new Error('PR AppImage compression requires the existing zstd configuration')
  }
  // Resolve the original override before installing the private, child-only overlay.
  const tools = await getTools(configuration.toolsets.appimage)
  const version = runProcessSync({
    program: tools.mksquashfs,
    args: ['-version'],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  if (
    version.code !== 0 ||
    version.timedOut ||
    version.outputTruncated ||
    !/^mksquashfs version 4\.6\.1(?:\s|$)/m.test(version.stdout)
  ) {
    throw new Error(
      `PR AppImage compression requires mksquashfs 4.6.1: ${describeProcessFailure(version)}`
    )
  }
  const directory = resolve(requestedDirectory)
  mkdirSync(directory)
  symlinkSync(tools.desktopFileValidate, join(directory, 'desktop-file-validate'))
  symlinkSync(dirname(tools.runtime), join(directory, 'runtimes'))
  symlinkSync(dirname(tools.runtimeLibraries), join(directory, 'lib'))
  writeFileSync(
    join(directory, 'mksquashfs'),
    '#!/usr/bin/env bash\nset -euo pipefail\nexec "$ORCA_PR_APPIMAGE_MKSQUASHFS" "$@" -Xcompression-level 3\n',
    { mode: 0o755 }
  )
  return {
    APPIMAGE_TOOLS_PATH: directory,
    ORCA_PR_APPIMAGE_MKSQUASHFS: tools.mksquashfs
  }
}
