import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function createLocalBuildVersion(baseVersion, timestamp, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Local build timestamp is invalid.')
  }
  const sanitizedCommit = commit.replace(/[^0-9A-Za-z-]/g, '').slice(0, 12)
  if (!sanitizedCommit) {
    throw new Error('Git commit identity is empty.')
  }
  const suffix = `local.${timestamp}.${sanitizedCommit}`
  return baseVersion.includes('-') ? `${baseVersion}.${suffix}` : `${baseVersion}-${suffix}`
}

export function getLocalBuildIdentity() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  return {
    commit,
    version: createLocalBuildVersion(packageJson.version, Date.now(), commit)
  }
}

export function removeUnpackedMacApps(outputDir = 'dist') {
  for (const architecture of ['mac', 'mac-arm64']) {
    rmSync(join(outputDir, architecture, 'Orca.app'), { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getLocalBuildIdentity()
  console.log(`[build:mac] local update version ${identity.version}`)
  try {
    execFileSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'electron-builder', '--config', 'config/electron-builder.config.cjs', '--mac'],
      {
        env: {
          ...process.env,
          ORCA_BUILD_COMMIT: identity.commit,
          ORCA_LOCAL_BUILD_VERSION: identity.version
        },
        stdio: 'inherit'
      }
    )
  } finally {
    removeUnpackedMacApps()
  }
}
