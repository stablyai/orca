#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve7zaPath } from '../../archives/seven-zip/resolve-7za-path.mjs'

export const WINDOWS_PORTABLE_ROOT_DIR = 'Orca-portable'
export const WINDOWS_PORTABLE_ARCHIVE_NAME = 'orca-windows-x64-portable.zip'
export const WINDOWS_PORTABLE_SHA256_NAME = `${WINDOWS_PORTABLE_ARCHIVE_NAME}.sha256`

function readArg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name)
  return index !== -1 ? argv[index + 1] : undefined
}

export async function packageWindowsPortable({
  unpackedDir,
  outDir,
  projectDir = resolve(import.meta.dirname, '../../../..'),
  archiveName = WINDOWS_PORTABLE_ARCHIVE_NAME
}) {
  const resolvedUnpacked = resolve(unpackedDir)
  const resolvedOut = resolve(outDir)
  if (!existsSync(join(resolvedUnpacked, 'Orca.exe'))) {
    throw new Error(`Missing unpacked Orca.exe in ${resolvedUnpacked}`)
  }
  if (!existsSync(join(resolvedUnpacked, 'resources', 'app.asar'))) {
    throw new Error(`Missing unpacked resources/app.asar in ${resolvedUnpacked}`)
  }

  const stageParent = join(resolvedOut, '.portable-stage')
  const stageRoot = join(stageParent, WINDOWS_PORTABLE_ROOT_DIR)
  const archivePath = join(resolvedOut, archiveName)
  const sha256Path = `${archivePath}.sha256`

  rmSync(stageParent, { recursive: true, force: true })
  rmSync(archivePath, { force: true })
  rmSync(sha256Path, { force: true })
  mkdirSync(stageParent, { recursive: true })

  try {
    // Stage a separate copy so win-unpacked stays untouched for NSIS installer packaging.
    cpSync(resolvedUnpacked, stageRoot, { recursive: true, dereference: false })
    writeFileSync(join(stageRoot, 'resources', 'package-type'), 'portable\n', 'utf8')
    mkdirSync(join(stageRoot, 'data'), { recursive: true })
    writeFileSync(join(stageRoot, 'data', '.keep'), '', 'utf8')

    const sevenZa = resolve(await resolve7zaPath(projectDir))
    execFileSync(sevenZa, ['a', '-tzip', '-mx=9', archivePath, WINDOWS_PORTABLE_ROOT_DIR], {
      cwd: stageParent,
      stdio: 'inherit'
    })

    const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
    writeFileSync(sha256Path, `${digest}  ${archiveName}\n`, 'utf8')
    return { archivePath, sha256Path, sha256: digest }
  } finally {
    rmSync(stageParent, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const projectDir = resolve(import.meta.dirname, '../../../..')
  const unpackedDir = readArg('--unpacked-dir') ?? join(projectDir, 'dist', 'win-unpacked')
  const outDir = readArg('--out-dir') ?? join(projectDir, 'dist')
  const result = await packageWindowsPortable({ unpackedDir, outDir, projectDir })
  console.log(`[package-windows-portable] wrote ${result.archivePath} (${result.sha256})`)
}
