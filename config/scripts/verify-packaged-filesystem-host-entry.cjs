const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

function assertPackagedFilesystemHostEntryExists(resourcesDir) {
  const entryPath = join(
    resourcesDir,
    'app.asar.unpacked',
    'out',
    'main',
    'filesystem-host-entry.js'
  )
  if (!existsSync(entryPath)) {
    throw new Error(
      `[verify-packaged-filesystem-host-entry] missing unpacked entry at ${entryPath}`
    )
  }
  return entryPath
}

function buildPackagedFilesystemHostSelfTestEnv(source = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    return {}
  }
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (source[key] !== undefined) {
      env[key] = source[key]
    }
  }
  return env
}

function verifyPackagedFilesystemHostEntryBoots(resourcesDir, options = {}) {
  const entryPath = assertPackagedFilesystemHostEntryExists(resourcesDir)
  const result = spawnSync(options.execPath || process.execPath, [entryPath, '--self-test'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: buildPackagedFilesystemHostSelfTestEnv()
  })
  if (result.error) {
    throw new Error(
      `[verify-packaged-filesystem-host-entry] launch failed: ${result.error.message}`
    )
  }
  if (result.status !== 0 || !result.stdout.includes('"protocolVersion":1')) {
    throw new Error(
      `[verify-packaged-filesystem-host-entry] self-test failed: ${result.stderr || result.stdout}`
    )
  }
  console.log('[verify-packaged-filesystem-host-entry] OK')
}

module.exports = {
  assertPackagedFilesystemHostEntryExists,
  buildPackagedFilesystemHostSelfTestEnv,
  verifyPackagedFilesystemHostEntryBoots
}
