const { execFileSync } = require('node:child_process')
const { readFileSync, rmSync } = require('node:fs')
const { basename, resolve, sep } = require('node:path')
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')

const projectDir = resolve(__dirname, '../..')

function electronBuilderBeforeBuild(context, runner = execFileSync) {
  const shouldContinue = electronBuilderNativeRebuild(context)
  const preparationArgs = buildWslRuntimePreparationArgs(context)
  if (preparationArgs) {
    const output = runner(process.execPath, preparationArgs, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit']
    })
    const prepared = parseWslRuntimePreparationOutput(output)
    process.env.ORCA_WSL_WATCHER_BUILD_SOURCE = prepared.source
    process.env.ORCA_WSL_WATCHER_BUILD_LEASE = prepared.lease
  }
  return shouldContinue
}

function buildWslRuntimePreparationArgs(context) {
  const platform =
    typeof context?.platform === 'string' ? context.platform : context?.platform?.nodeName
  if (platform === 'win32') {
    const processStartToken = currentProcessStartToken()
    if (!processStartToken) {
      throw new Error(`Could not determine Electron Builder process identity for ${process.pid}`)
    }
    // Why: Windows cannot execute Linux native addons directly, so package a
    // verified Linux runtime that can be installed inside each WSL distro.
    return [
      'config/scripts/prepare-wsl-watcher-runtime.mjs',
      '--print-package-source',
      '--lease-owner-pid',
      String(process.pid),
      '--lease-owner-start-token',
      processStartToken
    ]
  }
  return null
}

let cachedProcessStartToken
function currentProcessStartToken() {
  if (cachedProcessStartToken !== undefined) {
    return cachedProcessStartToken
  }
  try {
    if (process.platform === 'linux') {
      const contents = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
      cachedProcessStartToken =
        contents.slice(contents.lastIndexOf(') ') + 2).split(' ')[19] || null
    } else if (process.platform === 'win32') {
      cachedProcessStartToken =
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
          ],
          { encoding: 'utf8', timeout: 2_000, windowsHide: true }
        ).trim() || null
    } else {
      cachedProcessStartToken =
        execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
          encoding: 'utf8',
          timeout: 2_000
        }).trim() || null
    }
  } catch {
    cachedProcessStartToken = null
  }
  return cachedProcessStartToken
}

function parseWslRuntimeBuildSource(output) {
  return parseWslRuntimePreparationOutput(output).source
}

function parseWslRuntimePreparationOutput(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output ?? '')
  const lines = text.split(/\r?\n/)
  const value = (name) => lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1)
  const source = value('ORCA_WSL_WATCHER_BUILD_SOURCE')
  const lease = value('ORCA_WSL_WATCHER_BUILD_LEASE')
  if (!source || !lease) {
    throw new Error('WSL watcher runtime preparation did not return an immutable leased source')
  }
  return { source, lease }
}

function releaseWslRuntimeBuildLease() {
  const configuredLease = process.env.ORCA_WSL_WATCHER_BUILD_LEASE
  delete process.env.ORCA_WSL_WATCHER_BUILD_LEASE
  if (!configuredLease) {
    return
  }
  const leasePath = resolve(projectDir, configuredLease)
  const buildsRoot = resolve(projectDir, 'out', 'wsl-watcher.builds')
  if (
    !leasePath.startsWith(`${buildsRoot}${sep}`) ||
    !/^[a-f0-9]{20}\.lease-/.test(basename(leasePath))
  ) {
    throw new Error(`Refusing to release invalid WSL runtime build lease: ${configuredLease}`)
  }
  rmSync(leasePath, { recursive: true, force: true })
}

module.exports = electronBuilderBeforeBuild
module.exports.default = electronBuilderBeforeBuild
module.exports.buildWslRuntimePreparationArgs = buildWslRuntimePreparationArgs
module.exports.parseWslRuntimeBuildSource = parseWslRuntimeBuildSource
module.exports.parseWslRuntimePreparationOutput = parseWslRuntimePreparationOutput
module.exports.releaseWslRuntimeBuildLease = releaseWslRuntimeBuildLease
module.exports.currentProcessStartToken = currentProcessStartToken
