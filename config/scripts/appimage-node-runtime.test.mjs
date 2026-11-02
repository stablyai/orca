import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  appImageNodeRuntimeFpmArgs,
  placeAppImageNodeRuntime
} = require('./appimage-node-runtime.cjs')
const releaseConfig = require('../electron-builder.config.cjs')
const prLinuxConfig = require('../electron-builder-pr-linux.config.cjs')

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-appimage-node-pack-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Ruby's File.fnmatch without flags, which is how fpm applies --exclude: `*` crosses `/`. */
function fpmExcludes(pattern, stagedPath) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${source}$`).test(stagedPath)
}

describe('the pinned Node in Linux packages', () => {
  it('is placed under resources as an executable bin/node for the slice arch', async () => {
    const pinned = join(root, 'pinned-node')
    writeFileSync(pinned, 'node bytes')
    const requested = []
    const destination = await placeAppImageNodeRuntime(join(root, 'resources'), 'arm64', (t) => {
      requested.push(t)
      return pinned
    })
    expect(requested).toEqual(['linux-arm64-glibc'])
    expect(destination).toBe(join(root, 'resources', 'node-runtime', 'bin', 'node'))
    expect(readFileSync(destination, 'utf8')).toBe('node bytes')
    expect(statSync(destination).mode & 0o777).toBe(0o755)
  })

  it('fails packaging for a slice the pin has no glibc build for', async () => {
    await expect(
      placeAppImageNodeRuntime(join(root, 'resources'), 'ia32', () => '')
    ).rejects.toThrow('no glibc build for Linux ia32')
  })

  it('ships only in the AppImage: deb and rpm exclude it, release and PR builds alike', () => {
    for (const config of [releaseConfig, prLinuxConfig]) {
      for (const target of ['deb', 'rpm']) {
        const fpm = config[target].fpm.join('\0')
        expect(fpm).toContain(appImageNodeRuntimeFpmArgs.join('\0'))
      }
      expect(config.appImage.fpm).toBeUndefined()
    }
    const [, pattern] = appImageNodeRuntimeFpmArgs
    expect(fpmExcludes(pattern, 'opt/Orca/resources/node-runtime')).toBe(true)
    expect(fpmExcludes(pattern, 'opt/Orca/resources/node_modules')).toBe(false)
    expect(fpmExcludes(pattern, 'opt/Orca/resources/app.asar.unpacked/out/node-runtime')).toBe(
      false
    )
  })
})
