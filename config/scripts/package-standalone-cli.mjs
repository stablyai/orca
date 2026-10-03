#!/usr/bin/env node
/**
 * Pack the standalone CLI bundle as an npm-installable tarball:
 * `npm i -g ./orca-cli-<version>.tgz` (or the release URL) installs `orca`.
 */
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { create as createTar } from 'tar'
import {
  STANDALONE_CLI_BUNDLE_FILENAME,
  STANDALONE_CLI_OUT_DIR,
  STANDALONE_CLI_PACKAGE_NAME,
  buildStandaloneCli
} from './build-standalone-cli.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const LAUNCHER_SOURCE = join(ROOT, 'config', 'standalone-cli', 'bin-orca.cjs')
const LICENSE_SOURCE = join(ROOT, 'LICENSE')

export async function packageStandaloneCli({
  bundleDir = STANDALONE_CLI_OUT_DIR,
  outputDir = STANDALONE_CLI_OUT_DIR,
  launcherPath = LAUNCHER_SOURCE,
  licensePath = LICENSE_SOURCE
} = {}) {
  const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${join(bundleDir, 'package.json')} has no stamped version`)
  }
  const stage = await mkdtemp(join(tmpdir(), 'orca-cli-package-'))
  // Why: npm installs a tarball only when its entries live under `package/`.
  const packageDir = join(stage, 'package')
  const archivePath = join(outputDir, `${STANDALONE_CLI_PACKAGE_NAME}-${manifest.version}.tgz`)
  const latestPath = join(outputDir, `${STANDALONE_CLI_PACKAGE_NAME}.tgz`)
  try {
    await mkdir(join(packageDir, 'bin'), { recursive: true })
    await mkdir(outputDir, { recursive: true })
    await copyFile(join(bundleDir, 'package.json'), join(packageDir, 'package.json'))
    await copyFile(
      join(bundleDir, STANDALONE_CLI_BUNDLE_FILENAME),
      join(packageDir, STANDALONE_CLI_BUNDLE_FILENAME)
    )
    await copyFile(launcherPath, join(packageDir, 'bin', 'orca'))
    await copyFile(licensePath, join(packageDir, 'LICENSE'))
    await chmod(join(packageDir, 'bin', 'orca'), 0o755)
    await createTar(
      { cwd: stage, file: archivePath, gzip: true, portable: true, noMtime: true, strict: true },
      ['package']
    )
    await copyFile(archivePath, latestPath)
    return { archivePath, latestPath, version: manifest.version }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    await buildStandaloneCli()
  }
  const { archivePath, latestPath } = await packageStandaloneCli()
  process.stdout.write(`${archivePath}\n${latestPath}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
