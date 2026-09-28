#!/usr/bin/env node
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { copyPrivateTree } from './space-sharing-copy.mjs'
import { spawnProcess } from './script-child-process.mjs'

const require = createRequire(import.meta.url)
const formats = ['AppImage', 'deb', 'rpm']

export function linuxFormatArguments({ format, appDirectory, outputDirectory }) {
  if (!formats.includes(format)) {
    throw new Error(`Unsupported Linux package format: ${format}`)
  }
  return [
    '--config',
    'config/electron-builder.config.cjs',
    '--linux',
    format,
    '--x64',
    '--publish',
    'never',
    '--prepackaged',
    appDirectory,
    '--config.directories.output',
    outputDirectory,
    '--config.deb.compression=gz',
    '--config.rpm.compression=gzip'
  ]
}

function runElectronBuilder(args) {
  return new Promise((resolveBuild, reject) => {
    const child = spawnProcess({
      program: process.execPath,
      args: [require.resolve('electron-builder/cli.js'), ...args],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolveBuild()
      } else {
        reject(new Error(`electron-builder failed (code=${code}, signal=${signal})`))
      }
    })
  })
}

export async function packageLinuxFormats({
  preparedDirectory = resolve('dist/linux-unpacked'),
  outputDirectory = resolve('dist'),
  runBuilder = runElectronBuilder
} = {}) {
  const marker = join(preparedDirectory, 'resources/package-type')
  if (readFileSync(marker, 'utf8') !== 'AppImage') {
    throw new Error('Expected a fresh Linux directory build with its AppImage package marker')
  }
  const startedAt = performance.now()
  mkdirSync(outputDirectory, { recursive: true })
  const staging = mkdtempSync(join(outputDirectory, '.linux-package-formats-'))
  try {
    const results = await Promise.allSettled(
      formats.map(async (format) => {
        const startedFormatAt = performance.now()
        const appDirectory = join(staging, format, 'app')
        const formatOutput = join(staging, format, 'artifacts')
        mkdirSync(join(staging, format))
        // Preserve packaged modes; only the format metadata may be rewritten by electron-builder.
        copyPrivateTree(preparedDirectory, appDirectory, { unprotect: () => {} })
        console.log(
          `[linux-package] ${format} copied in ${Math.round(performance.now() - startedFormatAt)}ms`
        )
        await runBuilder(
          linuxFormatArguments({ format, appDirectory, outputDirectory: formatOutput })
        )
        const artifacts = readdirSync(formatOutput).filter((name) => name.endsWith(`.${format}`))
        const artifactStats =
          artifacts.length === 1 ? statSync(join(formatOutput, artifacts[0])) : null
        if (!artifactStats?.isFile() || artifactStats.size === 0) {
          throw new Error(`${format} did not produce exactly one nonempty package`)
        }
        console.log(
          `[linux-package] ${format} finished in ${Math.round(performance.now() - startedFormatAt)}ms`
        )
        return { format, formatOutput, artifact: artifacts[0] }
      })
    )
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [new Error(`${formats[index]} packaging failed`, { cause: result.reason })]
        : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Linux package formats failed')
    }
    const completed = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    const metadataDirectory = join(outputDirectory, 'linux-package-formats')
    for (const destination of [
      metadataDirectory,
      ...completed.map(({ artifact }) => join(outputDirectory, artifact))
    ]) {
      if (existsSync(destination)) {
        throw new Error(`Refusing to replace existing package output: ${destination}`)
      }
    }
    mkdirSync(metadataDirectory)
    for (const { format, formatOutput, artifact } of completed) {
      renameSync(join(formatOutput, artifact), join(outputDirectory, artifact))
      // Update manifests and builder diagnostics have overlapping names across formats.
      renameSync(formatOutput, join(metadataDirectory, format))
    }
    console.log(
      `[linux-package] all formats finished in ${Math.round(performance.now() - startedAt)}ms`
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('PR Linux packaging requires a Linux x64 host')
  }
  await packageLinuxFormats()
}
