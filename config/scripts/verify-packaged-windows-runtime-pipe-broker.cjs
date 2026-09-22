const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyPackagedWindowsRuntimePipeBroker(resourcesDir, options = {}) {
  const sourcePath =
    options.sourcePath ??
    resolve('native', 'windows-runtime-pipe-broker', '.build', 'orca-pipe-broker.exe')
  const packagedPath = join(resourcesDir, 'bin', 'orca-pipe-broker.exe')
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing built Windows runtime pipe broker: ${sourcePath}`)
  }
  if (!existsSync(packagedPath)) {
    throw new Error(`Missing packaged Windows runtime pipe broker: ${packagedPath}`)
  }
  const sourceHash = sha256(sourcePath)
  const packagedHash = sha256(packagedPath)
  if (packagedHash !== sourceHash) {
    throw new Error(
      `Packaged Windows runtime pipe broker hash mismatch: ${packagedHash} != ${sourceHash}`
    )
  }

  if (options.execute !== false) {
    const probe = spawnSync(packagedPath, ['unexpected-argument'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true
    })
    if (probe.error) {
      throw probe.error
    }
    if (probe.status !== 64) {
      throw new Error(
        `Packaged Windows runtime pipe broker execution probe exited ${probe.status ?? 'without a code'}; expected 64.`
      )
    }
  }
  return { sourceHash, packagedHash, packagedPath }
}

module.exports = { sha256, verifyPackagedWindowsRuntimePipeBroker }
