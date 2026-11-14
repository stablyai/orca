import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packageLinuxFormats } from './package-linux-formats.mjs'

let root
let preparedDirectory
let outputDirectory
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca formats with spaces-'))
  preparedDirectory = join(root, 'prepared app')
  outputDirectory = join(root, 'output packages')
  mkdirSync(join(preparedDirectory, 'resources'), { recursive: true })
  mkdirSync(outputDirectory)
  writeFileSync(join(preparedDirectory, 'resources/package-type'), 'AppImage')
  writeFileSync(join(preparedDirectory, 'resources/app.asar'), 'verified application')
  writeFileSync(join(preparedDirectory, 'orca-ide'), 'executable')
  chmodSync(join(preparedDirectory, 'orca-ide'), 0o755)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function emitPackage(args) {
  const format = valueAfter(args, '--linux')
  const app = valueAfter(args, '--prepackaged')
  const output = valueAfter(args, '--config.directories.output')
  writeFileSync(join(app, 'resources/package-type'), format)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `orca.${format}`), format)
  writeFileSync(join(output, 'latest-linux.yml'), format)
  return { format, app, output }
}

describe('independent Linux package formats', () => {
  it('settles every worker before cleanup and exposes no partial artifact on builder failure', async () => {
    const finished = []
    let overlay
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    await expect(
      packageLinuxFormats({
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async ({ directory }) => {
          overlay = directory
          mkdirSync(directory)
          writeFileSync(join(directory, 'mksquashfs'), 'private wrapper')
          return { APPIMAGE_TOOLS_PATH: directory, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
        },
        runBuilder: async (args) => {
          const format = valueAfter(args, '--linux')
          if (format === 'AppImage') {
            throw new Error('compression failed')
          }
          if (format === 'rpm') {
            release()
          }
          await gate
          const { app } = emitPackage(args)
          expect(existsSync(app)).toBe(true)
          expect(existsSync(overlay)).toBe(true)
          finished.push(format)
        }
      })
    ).rejects.toMatchObject({
      message: 'Linux package formats failed',
      errors: [
        expect.objectContaining({
          message: 'AppImage packaging failed',
          cause: expect.objectContaining({ message: 'compression failed' })
        })
      ]
    })
    expect(finished.sort()).toEqual(['deb', 'rpm'])
    expect(existsSync(overlay)).toBe(false)
    expect(readdirSync(outputDirectory)).toEqual([])
    expect(readFileSync(join(preparedDirectory, 'resources/package-type'), 'utf8')).toBe('AppImage')
  })

  it('rejects missing artifacts even when the builder reports success', async () => {
    await expect(
      packageLinuxFormats({
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async () => ({}),
        runBuilder: async (args) => {
          const result = emitPackage(args)
          if (result.format === 'rpm') {
            writeFileSync(join(result.output, 'orca.rpm'), '')
          }
        }
      })
    ).rejects.toThrow('Linux package formats failed')
    expect(readdirSync(outputDirectory)).toEqual([])
  })

  it('does not replace existing output packages', async () => {
    writeFileSync(join(outputDirectory, 'orca.deb'), 'previous package')
    await expect(
      packageLinuxFormats({
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async () => ({}),
        runBuilder: async (args) => {
          emitPackage(args)
        }
      })
    ).rejects.toThrow('Refusing to replace existing package output')
    expect(readdirSync(outputDirectory)).toEqual(['orca.deb'])
    expect(readFileSync(join(outputDirectory, 'orca.deb'), 'utf8')).toBe('previous package')
  })
})
