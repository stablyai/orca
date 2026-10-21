import { resolve } from 'node:path'
import { resolveConfig as resolveElectronConfig } from 'electron-vite'
import { resolveConfig } from 'vite'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.stubEnv('ORCA_UNMINIFIED_MAIN', '')
  vi.stubEnv('ORCA_DEV_MAIN_SOURCEMAPS', '')
  vi.stubEnv('NODE_ENV', process.env.NODE_ENV)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function resolveMainConfig(command: 'build' | 'serve', watch = false) {
  const resolved = await resolveElectronConfig(
    { logLevel: 'silent', ...(watch ? { build: { watch: {} } } : {}) },
    command,
    command === 'serve' ? 'development' : 'production'
  )
  if (!resolved.config?.main) {
    throw new Error('Electron Vite did not resolve the main-process configuration')
  }
  // Electron Vite runs main through Vite's build command even in development.
  return resolveConfig({ ...resolved.config.main, configFile: false }, 'build')
}

describe('Electron Vite development compilation', () => {
  it('keeps the watch-only TypeScript API out of production config loading', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module';
import { resolveConfig } from 'electron-vite';
await resolveConfig({ logLevel: 'silent' }, 'build');
const require = createRequire(import.meta.url);
console.log(JSON.stringify({ loaded: Object.hasOwn(require.cache, require.resolve('typescript-api')) }));`
      ],
      cwd: process.cwd()
    })

    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ loaded: false })
  })

  it.each([false, true])('skips main minification in development (watch=%s)', async (watch) => {
    const resolved = await resolveMainConfig('serve', watch)

    expect(resolved.build.minify).toBe(false)
    expect(resolved.build.sourcemap).toBe('hidden')
    expect(resolved.build.reportCompressedSize).toBe(false)
    expect(Boolean(resolved.build.watch)).toBe(watch)
  })

  it('keeps production minification and crash source maps', async () => {
    const resolved = await resolveMainConfig('build')

    expect(resolved.build.minify).toBe('oxc')
    expect(resolved.build.sourcemap).toBe('hidden')
    expect(resolved.build.reportCompressedSize).toBe(false)
  })

  it('honors the unminified main diagnostic override in production', async () => {
    vi.stubEnv('ORCA_UNMINIFIED_MAIN', '1')

    const resolved = await resolveMainConfig('build')

    expect(resolved.build.minify).toBe(false)
    expect(resolved.build.sourcemap).toBe('hidden')
  })

  it('honors the development source-map override alongside unminified compilation', async () => {
    vi.stubEnv('ORCA_DEV_MAIN_SOURCEMAPS', '0')

    const development = await resolveMainConfig('serve')
    const production = await resolveMainConfig('build')

    expect(development.build.minify).toBe(false)
    expect(development.build.sourcemap).toBe(false)
    expect(production.build.minify).toBe('oxc')
    expect(production.build.sourcemap).toBe('hidden')
  })

  it('keeps renderer dependency caches in this worktree and skips gzip reporting', async () => {
    const { config } = await resolveElectronConfig({ logLevel: 'silent' }, 'serve')
    if (!config?.renderer) {
      throw new Error('Electron Vite did not resolve the renderer configuration')
    }

    const resolved = await resolveConfig({ ...config.renderer, configFile: false }, 'serve')

    expect(resolved.cacheDir).toBe(resolve('.cache/vite/renderer').replaceAll('\\', '/'))
    expect(resolved.build.reportCompressedSize).toBe(false)
  })

  it('gives the web client its own worktree cache and skips gzip reporting', async () => {
    const resolved = await resolveConfig(
      { configFile: resolve('vite.web.config.ts'), logLevel: 'silent' },
      'serve'
    )

    expect(resolved.cacheDir).toBe(resolve('.cache/vite/web').replaceAll('\\', '/'))
    expect(resolved.build.reportCompressedSize).toBe(false)
  })
})
