import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preparePrAppImageTools } from './package-linux-formats-appimage.mjs'
import { runProcessSync } from '@orca/process-host'

const require = createRequire(import.meta.url)
const configuration = { toolsets: { appimage: '1.0.3' } }
let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca pr AppImage tools-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each([
  ['linux', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'x64']
])('refuses unmeasured %s/%s hosts before resolving tools', async (platform, architecture) => {
  const getTools = vi.fn()
  await expect(
    preparePrAppImageTools({
      directory: join(root, 'overlay'),
      configuration,
      getTools,
      platform,
      architecture
    })
  ).rejects.toThrow('requires a Linux x64 host')
  expect(getTools).not.toHaveBeenCalled()
})

it.each([
  [{ toolsets: { appimage: '1.0.2' } }, 'pinned AppImage toolset 1.0.3'],
  [{ ...configuration, appImage: { compression: 'gzip' } }, 'existing zstd configuration'],
  [{ ...configuration, compression: 'store' }, 'existing zstd configuration']
])('rejects unsupported configuration %j before resolving tools', async (value, message) => {
  const getTools = vi.fn()
  await expect(
    preparePrAppImageTools({
      directory: join(root, 'overlay'),
      configuration: value,
      getTools,
      platform: 'linux',
      architecture: 'x64'
    })
  ).rejects.toThrow(message)
  expect(getTools).not.toHaveBeenCalled()
})

describe.skipIf(process.platform === 'win32')('real executable AppImage tool overlay', () => {
  let original
  let overlay

  beforeEach(() => {
    original = join(root, 'custom tools with spaces')
    overlay = join(root, 'private tools')
    mkdirSync(join(original, 'runtimes'), { recursive: true })
    mkdirSync(join(original, 'lib', 'x64'), { recursive: true })
    writeFileSync(join(original, 'runtimes', 'runtime-x64'), 'unchanged static runtime')
    writeFileSync(join(original, 'lib', 'x64', 'lib.so'), 'unchanged runtime library')
    writeFileSync(join(original, 'desktop-file-validate'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755
    })
    writeFileSync(
      join(original, 'mksquashfs'),
      [
        '#!/usr/bin/env node',
        'if (process.argv[2] === "-version") {',
        '  console.log(`mksquashfs version ${process.env.ORCA_TEST_SQUASHFS_VERSION ?? "4.6.1"}`)',
        '} else { console.log(JSON.stringify(process.argv.slice(2))) }',
        'process.exitCode = Number(process.env.ORCA_TEST_SQUASHFS_EXIT ?? 0)',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    vi.stubEnv('APPIMAGE_TOOLS_PATH', original)
  })

  function prepare(options = {}) {
    return preparePrAppImageTools({
      directory: overlay,
      configuration,
      platform: 'linux',
      architecture: 'x64',
      ...options
    })
  }

  it('honors a custom toolset, preserving every original argument and runtime byte', async () => {
    const originalProgram = join(original, 'mksquashfs')
    const programBytes = readFileSync(originalProgram)
    const environment = await prepare()
    const args = [
      'app spaces \' " $HOME $(touch expanded) `touch expanded`',
      'output\nwith newline',
      '-offset',
      '944632',
      '-comp',
      'zstd'
    ]
    const result = runProcessSync({
      program: join(overlay, 'mksquashfs'),
      args,
      cwd: root,
      env: { ...process.env, ...environment },
      timeoutMs: 10_000
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([...args, '-Xcompression-level', '3'])
    expect(existsSync(join(root, 'expanded'))).toBe(false)
    expect(statSync(join(overlay, 'mksquashfs')).mode & 0o777).toBe(0o755)
    expect(readFileSync(originalProgram)).toEqual(programBytes)
    expect(process.env.APPIMAGE_TOOLS_PATH).toBe(original)
    expect(environment.ORCA_PR_APPIMAGE_MKSQUASHFS).toBe(originalProgram)

    vi.stubEnv('APPIMAGE_TOOLS_PATH', environment.APPIMAGE_TOOLS_PATH)
    const tools = await require('app-builder-lib/out/toolsets/linux.js').getAppImageTools(
      '1.0.3',
      require('builder-util').Arch.x64
    )
    for (const [actual, expected] of [
      [tools.desktopFileValidate, join(original, 'desktop-file-validate')],
      [tools.runtime, join(original, 'runtimes', 'runtime-x64')],
      [tools.runtimeLibraries, join(original, 'lib', 'x64')]
    ]) {
      expect(realpathSync(actual)).toBe(realpathSync(expected))
    }
    expect(readFileSync(tools.runtime, 'utf8')).toBe('unchanged static runtime')
    expect(readFileSync(join(tools.runtimeLibraries, 'lib.so'), 'utf8')).toBe(
      'unchanged runtime library'
    )
  })

  it('quotes an original executable path containing shell metacharacters', async () => {
    const tools = await require('app-builder-lib/out/toolsets/linux.js').getAppImageTools(
      '1.0.3',
      require('builder-util').Arch.x64
    )
    const program = join(root, 'tool \' " $(touch expanded) `touch expanded`')
    writeFileSync(program, readFileSync(tools.mksquashfs), { mode: 0o755 })
    const environment = await prepare({ getTools: async () => ({ ...tools, mksquashfs: program }) })
    const result = runProcessSync({
      program: join(overlay, 'mksquashfs'),
      args: ['app', 'output', '-comp', 'zstd'],
      cwd: root,
      env: { ...process.env, ...environment },
      timeoutMs: 10_000
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      'app',
      'output',
      '-comp',
      'zstd',
      '-Xcompression-level',
      '3'
    ])
    expect(existsSync(join(root, 'expanded'))).toBe(false)
  })

  it('normalizes a relative overlay into an absolute builder override', async () => {
    const environment = await prepare({ directory: relative(process.cwd(), overlay) })
    expect(environment.APPIMAGE_TOOLS_PATH).toBe(overlay)
    expect(existsSync(join(overlay, 'mksquashfs'))).toBe(true)
  })

  it('propagates the original executable failure without a fallback', async () => {
    const environment = await prepare()
    vi.stubEnv('ORCA_TEST_SQUASHFS_EXIT', '17')
    const result = runProcessSync({
      program: join(overlay, 'mksquashfs'),
      args: ['app', 'output', '-comp', 'zstd'],
      env: { ...process.env, ...environment },
      timeoutMs: 10_000
    })
    expect(result.code).toBe(17)
  })

  it.each([
    ['ORCA_TEST_SQUASHFS_VERSION', '4.7.0'],
    ['ORCA_TEST_SQUASHFS_EXIT', '2']
  ])(
    'rejects an unsupported original tool (%s=%s) without creating an overlay',
    async (key, value) => {
      vi.stubEnv(key, value)
      await expect(prepare()).rejects.toThrow('requires mksquashfs 4.6.1')
      expect(existsSync(overlay)).toBe(false)
    }
  )

  it('keeps invalid custom toolset errors instead of downloading another toolset', async () => {
    vi.stubEnv('APPIMAGE_TOOLS_PATH', join(root, 'missing custom tools'))
    await expect(prepare()).rejects.toThrow(/APPIMAGE_TOOLS_PATH|AppImage tool/)
    expect(existsSync(overlay)).toBe(false)
  })

  it('preserves upstream rejection of unsafe custom override paths', async () => {
    vi.stubEnv('APPIMAGE_TOOLS_PATH', join(root, 'tools $(touch expanded)'))
    await expect(prepare()).rejects.toThrow('APPIMAGE_TOOLS_PATH contains shell-unsafe characters')
    expect(existsSync(overlay)).toBe(false)
    expect(existsSync(join(root, 'expanded'))).toBe(false)
  })
})
