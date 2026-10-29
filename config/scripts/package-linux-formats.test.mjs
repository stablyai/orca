import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linuxFormatArguments, packageLinuxFormats } from './package-linux-formats.mjs'

let root
let preparedDirectory
let outputDirectory
const targets = ['AppImage', 'deb', 'rpm']
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

it('preserves configured hooks, architecture, names, and PR compression with exact argv', () => {
  const args = linuxFormatArguments({
    format: 'deb',
    appDirectory: '/app with spaces',
    outputDirectory: '/out with spaces'
  })
  expect(args).toEqual([
    '--config',
    'config/electron-builder-pr-linux.config.cjs',
    '--linux',
    'deb',
    '--x64',
    '--publish',
    'never',
    '--prepackaged',
    '/app with spaces',
    '--config.directories.output',
    '/out with spaces',
    '--config.deb.compression=gz',
    '--config.rpm.compression=gzip'
  ])
  expect(() => linuxFormatArguments({ format: 'zip' })).toThrow('Unsupported Linux package format')
})

describe('independent Linux package formats', () => {
  it('starts all formats before awaiting completion and isolates metadata writes', async () => {
    if (process.platform !== 'win32') {
      symlinkSync('resources/package-type', join(preparedDirectory, 'marker-link'))
    }
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const copies = []
    await packageLinuxFormats({
      preparedDirectory,
      outputDirectory,
      prepareAppImageTools: async () => ({}),
      runBuilder: async (args) => {
        const app = valueAfter(args, '--prepackaged')
        const format = valueAfter(args, '--linux')
        expect(readFileSync(join(app, 'resources/package-type'), 'utf8')).toBe('AppImage')
        expect(readFileSync(join(app, 'resources/app.asar'), 'utf8')).toBe('verified application')
        if (process.platform !== 'win32') {
          expect(readlinkSync(join(app, 'marker-link'))).toBe('resources/package-type')
          expect(statSync(join(app, 'orca-ide')).mode & 0o777).toBe(0o755)
          expect(statSync(join(app, 'resources/package-type')).ino).not.toBe(
            statSync(join(preparedDirectory, 'resources/package-type')).ino
          )
        }
        copies.push(app)
        if (copies.length === 3) {
          release()
        }
        await gate
        expect(readdirSync(outputDirectory)).toHaveLength(1)
        emitPackage(args)
        await Promise.resolve()
        expect(readFileSync(join(app, 'resources/package-type'), 'utf8')).toBe(format)
      }
    })
    expect(new Set(copies).size).toBe(3)
    expect(readFileSync(join(preparedDirectory, 'resources/package-type'), 'utf8')).toBe('AppImage')
    expect(readFileSync(join(preparedDirectory, 'resources/app.asar'), 'utf8')).toBe(
      'verified application'
    )
    for (const format of targets) {
      expect(readFileSync(join(outputDirectory, `orca.${format}`), 'utf8')).toBe(format)
      expect(
        readFileSync(
          join(outputDirectory, 'linux-package-formats', format, 'latest-linux.yml'),
          'utf8'
        )
      ).toBe(format)
    }
    expect(
      readdirSync(outputDirectory).some((name) => name.startsWith('.linux-package-formats-'))
    ).toBe(false)
  })

  it.each(['builder', 'tool preparation'])(
    'settles every worker before cleanup and exposes no partial artifact on %s failure',
    async (failurePhase) => {
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
            if (failurePhase === 'tool preparation') {
              throw new Error('compression failed')
            }
            return { APPIMAGE_TOOLS_PATH: directory, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
          },
          runBuilder: async (args, environment) => {
            const format = valueAfter(args, '--linux')
            if (format === 'AppImage') {
              expect(environment).toEqual({
                APPIMAGE_TOOLS_PATH: overlay,
                ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool'
              })
              throw new Error('compression failed')
            }
            expect(environment).toEqual({})
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
      expect(readFileSync(join(preparedDirectory, 'resources/package-type'), 'utf8')).toBe(
        'AppImage'
      )
    }
  )

  it('passes its private tool environment only to AppImage and removes it after success', async () => {
    const originalToolsPath = process.env.APPIMAGE_TOOLS_PATH
    let overlay
    const calls = []
    await packageLinuxFormats({
      preparedDirectory,
      outputDirectory,
      prepareAppImageTools: async ({ directory }) => {
        overlay = directory
        mkdirSync(directory)
        return { APPIMAGE_TOOLS_PATH: directory, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
      },
      runBuilder: async (args, environment) => {
        const format = valueAfter(args, '--linux')
        calls.push(format)
        expect(environment).toEqual(
          format === 'AppImage'
            ? { APPIMAGE_TOOLS_PATH: overlay, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
            : {}
        )
        expect(process.env.APPIMAGE_TOOLS_PATH).toBe(originalToolsPath)
        emitPackage(args)
      }
    })
    expect(calls.sort()).toEqual(targets.slice().sort())
    expect(existsSync(overlay)).toBe(false)
    expect(process.env.APPIMAGE_TOOLS_PATH).toBe(originalToolsPath)
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

  it('rejects a tree already mutated by a previous root-package build', async () => {
    writeFileSync(join(preparedDirectory, 'resources/package-type'), 'rpm')
    await expect(
      packageLinuxFormats({
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async () => ({}),
        runBuilder: async () => {
          throw new Error('must not run')
        }
      })
    ).rejects.toThrow('Expected a fresh Linux directory build')
    expect(readdirSync(outputDirectory)).toEqual([])
  })
})

it('changes only CI deb/rpm compression levels without mutating release settings or hooks', () => {
  const require = createRequire(import.meta.url)
  const release = require('../electron-builder.config.cjs')
  const before = { deb: { ...release.deb }, rpm: { ...release.rpm } }
  const ci = require('../electron-builder-pr-linux.config.cjs')
  expect(release.deb).toEqual(before.deb)
  expect(release.rpm).toEqual(before.rpm)
  expect(ci).toEqual({
    ...release,
    deb: { ...release.deb, fpm: [...(release.deb.fpm ?? []), '--deb-compression-level=1'] },
    rpm: { ...release.rpm, fpm: [...(release.rpm.fpm ?? []), '--rpm-compression-level=1'] }
  })
})
