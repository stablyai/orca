import { describe, expect, it } from 'vitest'
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'

const sep = process.platform === 'win32' ? '\\' : '/'

describe('buildParcelWatcherIgnoreOptions', () => {
  const options = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
  const ignoreGlob = new RegExp(options.ignoreGlobs?.[0] ?? '/(never)/')
  const isIgnored = (...components: string[]): boolean => ignoreGlob.test(components.join(sep))

  it('drops AppData trees at any depth', () => {
    expect(isIgnored('AppData', 'Local', 'Programs', 'x', 'app.exe')).toBe(true)
    expect(isIgnored('home', 'user', 'AppData', 'Roaming', 'y')).toBe(true)
    expect(isIgnored('AppData')).toBe(true)
  })

  it('drops installer staging suffix directories and their contents', () => {
    expect(
      isIgnored(
        'AppData',
        'Local',
        'Programs',
        'DockerDesktop.staging',
        'frontend',
        'resources',
        'app.asar'
      )
    ).toBe(true)
    expect(isIgnored('tools', 'Vendor.staging', 'tmp-delete', 'pkg.bin')).toBe(true)
    expect(isIgnored('Vendor.staging')).toBe(true)
  })

  it('drops asar archive events outside ignored directories', () => {
    expect(isIgnored('packages', 'app', 'resources', 'app.asar')).toBe(true)
    expect(isIgnored('app.asar')).toBe(true)
  })

  it('keeps similarly named source paths', () => {
    expect(isIgnored('src', 'AppDataManager.ts')).toBe(false)
    expect(isIgnored('staging', 'run.js')).toBe(false)
    expect(isIgnored('src', 'main.ts')).toBe(false)
    expect(isIgnored('packages', 'app', 'resources', 'app.asar.unpacked', 'lib.node')).toBe(false)
  })
})
