#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  WINDOWS_CONPTY_ARCHIVE,
  WINDOWS_CONPTY_FILES,
  WINDOWS_CONPTY_VERSION
} from '../../src/shared/windows-conpty-release.ts'
import { getZipExtractorCommand } from './zip-extractor-command.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const licensePath = join(root, 'config', 'licenses', 'windows-conpty-LICENSE.txt')
const maximumArchiveBytes = 16 * 1024 * 1024
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

export async function downloadConptyArchive(destination, fetcher = fetch) {
  const response = await fetcher(WINDOWS_CONPTY_ARCHIVE.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000)
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`ConPTY download failed: HTTP ${response.status}`)
  }
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.byteLength
    if (length > maximumArchiveBytes) {
      throw new Error('ConPTY archive exceeds download size limit')
    }
    chunks.push(chunk)
  }
  writeFileSync(destination, Buffer.concat(chunks))
}

export function verifyConptyDirectory(directory, arch) {
  const files = WINDOWS_CONPTY_FILES[arch]
  if (!files) {
    throw new Error(`Unsupported ConPTY architecture: ${arch}`)
  }
  for (const [filename, expected] of Object.entries(files)) {
    if (sha256(join(directory, filename)) !== expected) {
      throw new Error(`ConPTY checksum mismatch: ${arch}/${filename}`)
    }
  }
}

/** Pins both files independently; no node-pty installation or native rebuild is needed. */
export async function materializeWindowsConpty(arch, outputDir, options = {}) {
  if (!Object.hasOwn(WINDOWS_CONPTY_FILES, arch)) {
    throw new Error(`Unsupported ConPTY architecture: ${arch}`)
  }
  const cacheDir = options.cacheDir ?? join(root, 'out', '.windows-conpty', WINDOWS_CONPTY_VERSION)
  mkdirSync(cacheDir, { recursive: true })
  const archive = join(cacheDir, 'conpty.nupkg')
  if (existsSync(archive) && sha256(archive) !== WINDOWS_CONPTY_ARCHIVE.sha256) {
    rmSync(archive, { force: true })
  }
  const temporary = mkdtempSync(join(tmpdir(), 'orca-conpty-'))
  try {
    if (!existsSync(archive)) {
      const downloading = join(temporary, 'conpty.nupkg')
      await downloadConptyArchive(downloading, options.fetcher)
      if (sha256(downloading) !== WINDOWS_CONPTY_ARCHIVE.sha256) {
        throw new Error('ConPTY archive checksum mismatch')
      }
      // Publish on the cache filesystem, including when TEMP is on another volume.
      const staging = mkdtempSync(join(cacheDir, '.download-'))
      try {
        copyFileSync(downloading, join(staging, 'conpty.nupkg'))
        renameSync(join(staging, 'conpty.nupkg'), archive)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    const extracted = join(temporary, 'extracted')
    mkdirSync(extracted)
    const command = getZipExtractorCommand(archive, extracted)
    const result = runProcessSync({ program: command.file, args: command.args, timeoutMs: 120_000 })
    if (result.code !== 0) {
      throw new Error(`ConPTY extraction failed: ${result.stderr || result.stdout}`)
    }
    const selected = join(temporary, 'selected')
    mkdirSync(selected)
    copyFileSync(
      join(extracted, 'runtimes', `win-${arch}`, 'native', 'conpty.dll'),
      join(selected, 'conpty.dll')
    )
    copyFileSync(
      join(extracted, 'build', 'native', 'runtimes', arch, 'OpenConsole.exe'),
      join(selected, 'OpenConsole.exe')
    )
    verifyConptyDirectory(selected, arch)
    copyFileSync(licensePath, join(selected, 'LICENSE.txt'))
    copyFileSync(
      join(extracted, 'Microsoft.Windows.Console.ConPTY.nuspec'),
      join(selected, 'Microsoft.Windows.Console.ConPTY.nuspec')
    )
    writeFileSync(
      join(selected, 'conpty.json'),
      `${JSON.stringify(
        {
          version: WINDOWS_CONPTY_VERSION,
          arch,
          source: WINDOWS_CONPTY_ARCHIVE.url,
          archiveSha256: WINDOWS_CONPTY_ARCHIVE.sha256,
          files: WINDOWS_CONPTY_FILES[arch]
        },
        null,
        2
      )}\n`
    )
    mkdirSync(outputDir, { recursive: true })
    for (const filename of [
      ...Object.keys(WINDOWS_CONPTY_FILES[arch]),
      'LICENSE.txt',
      'Microsoft.Windows.Console.ConPTY.nuspec',
      'conpty.json'
    ]) {
      copyFileSync(join(selected, filename), join(outputDir, filename))
    }
    verifyConptyDirectory(outputDir, arch)
    return { directory: outputDir, library: join(outputDir, 'conpty.dll') }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arch = process.argv[2] ?? process.arch
  const output = resolve(process.argv[3] ?? join(root, 'out', 'windows-conpty', arch))
  await materializeWindowsConpty(arch, output)
  console.log(`ConPTY ${WINDOWS_CONPTY_VERSION} ${arch}: ${output}`)
}
