import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')
const {
  createPackagedRuntimeNodeModuleResources,
  findAsarEntry,
  prunePackagedNodePty,
  prunePackagedParcelWatcher,
  prunePackagedSherpaOnnx,
  prunePackagedRuntimeTypeDeclarations,
  prunePackagedZodSources,
  verifyPackagedMainRuntimeDeps
} = require('../packaged-runtime-node-modules.cjs')

const electronBuilderConfigPath = require.resolve('../electron-builder.config.cjs')
const macNotaryEnvKeys = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_KEYCHAIN',
  'ORCA_MAC_RELEASE'
]
const appleIdMacReleaseEnv = {
  APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
  APPLE_ID: 'release@example.com',
  APPLE_TEAM_ID: 'TEAMID',
  ORCA_MAC_RELEASE: '1'
}

async function withElectronBuilderConfigEnv(env, callback) {
  const previous = new Map(macNotaryEnvKeys.map((key) => [key, process.env[key]]))
  try {
    for (const key of macNotaryEnvKeys) {
      delete process.env[key]
    }
    Object.assign(process.env, env)
    delete require.cache[electronBuilderConfigPath]
    return await callback(require('../electron-builder.config.cjs'))
  } finally {
    for (const key of macNotaryEnvKeys) {
      const value = previous.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    delete require.cache[electronBuilderConfigPath]
  }
}

function createMacNotarizationContext(appOutDir) {
  return {
    appOutDir,
    electronPlatformName: 'darwin',
    packager: {
      appInfo: {
        productFilename: 'Orca'
      }
    }
  }
}

function requiredMacServeSimDylibPaths(appOutDir) {
  const resourcesDir = join(appOutDir, 'Orca.app', 'Contents', 'Resources')
  return [
    join(resourcesDir, 'serve-sim', 'dist', 'simcam', 'libSimCameraInjector.dylib'),
    join(resourcesDir, 'node_modules', 'serve-sim', 'dist', 'simcam', 'libSimCameraInjector.dylib')
  ]
}

function optionalMacServeSimDylibPaths(appOutDir) {
  const resourcesDir = join(appOutDir, 'Orca.app', 'Contents', 'Resources')
  return [
    join(
      resourcesDir,
      'app.asar.unpacked',
      'node_modules',
      'serve-sim',
      'dist',
      'simcam',
      'libSimCameraInjector.dylib'
    )
  ]
}

function macServeSimDylibPaths(appOutDir) {
  return [...requiredMacServeSimDylibPaths(appOutDir), ...optionalMacServeSimDylibPaths(appOutDir)]
}

function createMacNotarizationHost({ existingPaths, output = { status: 'Accepted' } }) {
  const calls = []
  let temporaryDirectoryIndex = 0
  const host = {
    calls,
    execFileSync: vi.fn((command, args, options = {}) => {
      calls.push({ args, command, options })
      if (command === 'xcrun') {
        return typeof output === 'string' ? output : JSON.stringify(output)
      }
      return ''
    }),
    existsSync: vi.fn((targetPath) => existingPaths.has(targetPath)),
    mkdtempSync: vi.fn((prefix) => `${prefix}${++temporaryDirectoryIndex}`),
    rmSync: vi.fn()
  }
  return host
}

async function runMacAfterSignWithHost(config, appOutDir, host) {
  return await config.__test.withMacNotarizationHost(host, async () => {
    await config.afterSign(createMacNotarizationContext(appOutDir))
  })
}

function expectNotaryCredentials(calls, credentials, expectedCallCount = 3) {
  const notaryCalls = calls.filter(({ command }) => command === 'xcrun')
  expect(notaryCalls).toHaveLength(expectedCallCount)
  for (const notaryCall of notaryCalls) {
    expect(notaryCall.args).toEqual(
      expect.arrayContaining([
        'notarytool',
        'submit',
        ...credentials,
        '--wait',
        '--output-format',
        'json'
      ])
    )
  }
}

describe('electron-builder config', () => {
  it('excludes repo-only source trees from app.asar', () => {
    expect(electronBuilderConfig.files).toEqual(
      expect.arrayContaining([
        '!src{,/**/*}',
        '!config{,/**/*}',
        '!docs{,/**/*}',
        '!mobile{,/**/*}',
        '!native{,/**/*}',
        '!skills{,/**/*}',
        '!tests{,/**/*}',
        '!Casks{,/**/*}',
        '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md}',
        '!out/**/*.test.js'
      ])
    )
  })

  it('keeps runtime resources available through extraResources', () => {
    expect(electronBuilderConfig.mac.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-macos/.build/release/Orca Computer Use.app',
          to: 'Orca Computer Use.app'
        })
      ])
    )
    expect(electronBuilderConfig.linux.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-linux/runtime.py',
          to: 'computer-use-linux/runtime.py'
        })
      ])
    )
    expect(electronBuilderConfig.win.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-windows/runtime.ps1',
          to: 'computer-use-windows/runtime.ps1'
        })
      ])
    )
  })

  it('keeps the macOS afterSign hook inert outside macOS release builds', async () => {
    for (const { context, env } of [
      { context: { electronPlatformName: 'darwin' }, env: {} },
      { context: { electronPlatformName: 'linux' }, env: { ORCA_MAC_RELEASE: '1' } }
    ]) {
      await withElectronBuilderConfigEnv(env, async (config) => {
        const host = createMacNotarizationHost({ existingPaths: new Set() })

        await expect(
          config.__test.withMacNotarizationHost(host, async () => {
            await config.afterSign(context)
          })
        ).resolves.toBeUndefined()
        expect(host.execFileSync).not.toHaveBeenCalled()
      })
    }
  })

  it('submits all packaged serve-sim camera dylib copies in macOS releases', async () => {
    await withElectronBuilderConfigEnv(appleIdMacReleaseEnv, async (config) => {
      const appOutDir = join(tmpdir(), 'orca-electron-builder-test')
      const dylibPaths = macServeSimDylibPaths(appOutDir)
      const host = createMacNotarizationHost({ existingPaths: new Set(dylibPaths) })

      await runMacAfterSignWithHost(config, appOutDir, host)

      const dittoCalls = host.calls.filter(({ command }) => command === 'ditto')
      const notaryCalls = host.calls.filter(({ command }) => command === 'xcrun')
      expect(dittoCalls).toHaveLength(dylibPaths.length)
      expect(notaryCalls).toHaveLength(dylibPaths.length)
      expect(dittoCalls.map(({ options }) => options.cwd)).toEqual(
        dylibPaths.map((dylibPath) => dirname(dylibPath))
      )
      expect(dittoCalls.every(({ options }) => options.timeout === 2 * 60 * 1000)).toBe(true)
      expect(notaryCalls.every(({ options }) => options.timeout === 45 * 60 * 1000)).toBe(true)
      expect(dittoCalls.map(({ args }) => args.at(-1))).toEqual(
        notaryCalls.map(({ args }) => args[2])
      )
      expectNotaryCredentials(host.calls, [
        '--apple-id',
        'release@example.com',
        '--password',
        'app-password',
        '--team-id',
        'TEAMID'
      ])
      expect(host.rmSync).toHaveBeenCalledTimes(dylibPaths.length)
    })
  })

  it('does not require optional app.asar.unpacked serve-sim dylibs in macOS releases', async () => {
    await withElectronBuilderConfigEnv(appleIdMacReleaseEnv, async (config) => {
      const appOutDir = join(tmpdir(), 'orca-electron-builder-test')
      const dylibPaths = requiredMacServeSimDylibPaths(appOutDir)
      const host = createMacNotarizationHost({ existingPaths: new Set(dylibPaths) })

      await runMacAfterSignWithHost(config, appOutDir, host)

      const dittoCalls = host.calls.filter(({ command }) => command === 'ditto')
      expect(dittoCalls).toHaveLength(dylibPaths.length)
      expect(dittoCalls.map(({ options }) => options.cwd)).toEqual(
        dylibPaths.map((dylibPath) => dirname(dylibPath))
      )
      expectNotaryCredentials(
        host.calls,
        ['--apple-id', 'release@example.com', '--password', 'app-password', '--team-id', 'TEAMID'],
        dylibPaths.length
      )
      expect(host.rmSync).toHaveBeenCalledTimes(dylibPaths.length)
    })
  })

  it('fails before notarization when a packaged serve-sim camera dylib is missing', async () => {
    await withElectronBuilderConfigEnv({ ORCA_MAC_RELEASE: '1' }, async (config) => {
      const appOutDir = join(tmpdir(), 'orca-electron-builder-test')
      const [firstDylibPath] = macServeSimDylibPaths(appOutDir)
      const host = createMacNotarizationHost({ existingPaths: new Set([firstDylibPath]) })

      await expect(
        config.__test.notarizeMacServeSimCameraDylibsWithHost(
          createMacNotarizationContext(appOutDir),
          host
        )
      ).rejects.toThrow('Missing serve-sim camera dylib for notarization')

      expect(host.execFileSync).not.toHaveBeenCalled()
    })
  })

  it('maps supported macOS notarization credential families to notarytool flags', async () => {
    const cases = [
      {
        credentials: ['--key', '/tmp/AuthKey.p8', '--key-id', 'KEYID', '--issuer', 'issuer'],
        env: {
          APPLE_API_ISSUER: 'issuer',
          APPLE_API_KEY: '/tmp/AuthKey.p8',
          APPLE_API_KEY_ID: 'KEYID',
          ORCA_MAC_RELEASE: '1'
        }
      },
      {
        credentials: [
          '--apple-id',
          'release@example.com',
          '--password',
          'app-password',
          '--team-id',
          'TEAMID'
        ],
        env: {
          APPLE_API_ISSUER: 'issuer',
          APPLE_API_KEY: '/tmp/AuthKey.p8',
          APPLE_API_KEY_ID: 'KEYID',
          ...appleIdMacReleaseEnv
        }
      },
      {
        credentials: ['--keychain', '/tmp/login.keychain-db', '--keychain-profile', 'orca-release'],
        env: {
          APPLE_KEYCHAIN: '/tmp/login.keychain-db',
          APPLE_KEYCHAIN_PROFILE: 'orca-release',
          ORCA_MAC_RELEASE: '1'
        }
      }
    ]

    for (const { credentials, env } of cases) {
      await withElectronBuilderConfigEnv(env, async (config) => {
        const appOutDir = join(tmpdir(), 'orca-electron-builder-test')
        const dylibPaths = macServeSimDylibPaths(appOutDir)
        const host = createMacNotarizationHost({ existingPaths: new Set(dylibPaths) })

        await runMacAfterSignWithHost(config, appOutDir, host)
        expectNotaryCredentials(host.calls, credentials)
      })
    }
  })

  it('fails macOS standalone notarization on partial credentials and bad notary output', async () => {
    for (const { env, message } of [
      {
        env: { APPLE_ID: 'release@example.com', ORCA_MAC_RELEASE: '1' },
        message: 'APPLE_APP_SPECIFIC_PASSWORD env var needs to be set'
      },
      {
        env: { APPLE_API_KEY: '/tmp/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', ORCA_MAC_RELEASE: '1' },
        message: 'Env vars APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER need to be set'
      }
    ]) {
      await withElectronBuilderConfigEnv(env, async (config) => {
        expect(() => config.__test.macNotarytoolCredentialArgs()).toThrow(message)
      })
    }

    for (const { output, message } of [
      { message: 'Standalone binary notarization failed', output: { status: 'Invalid' } },
      { message: '', output: '{not-json' }
    ]) {
      await withElectronBuilderConfigEnv(appleIdMacReleaseEnv, async (config) => {
        const appOutDir = join(tmpdir(), 'orca-electron-builder-test')
        const dylibPaths = macServeSimDylibPaths(appOutDir)
        const host = createMacNotarizationHost({ existingPaths: new Set(dylibPaths), output })

        const expectation = expect(
          config.__test.notarizeMacServeSimCameraDylibsWithHost(
            createMacNotarizationContext(appOutDir),
            host
          )
        ).rejects
        await (message ? expectation.toThrow(message) : expectation.toThrow())
      })
    }
  })

  it('surfaces macOS standalone notarization subprocess failures without secrets', async () => {
    await withElectronBuilderConfigEnv(appleIdMacReleaseEnv, async (config) => {
      const appOutDir = join(tmpdir(), 'orca-electron-builder-test')
      const dylibPaths = macServeSimDylibPaths(appOutDir)
      const host = createMacNotarizationHost({ existingPaths: new Set(dylibPaths) })
      host.execFileSync.mockImplementation((command, args, options = {}) => {
        host.calls.push({ args, command, options })
        if (command === 'xcrun') {
          throw new Error(`Command failed: xcrun ${args.join(' ')}`)
        }
        return ''
      })

      try {
        await config.__test.notarizeMacServeSimCameraDylibsWithHost(
          createMacNotarizationContext(appOutDir),
          host
        )
        throw new Error('Expected notarization to fail')
      } catch (error) {
        expect(error.message).toContain('Standalone binary notarization subprocess failed')
        expect(error.message).not.toMatch(/release@example\.com|app-password|TEAMID/)
        expect(error.message).toContain('[REDACTED]')
      }
      expect(host.rmSync).toHaveBeenCalled()
    })
  })

  it('unpacks the compiled CommonJS boundary with CLI runtime files', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['out/package.json', 'out/cli/**', 'out/shared/**'])
    )
  })

  it('uses the multi-size icon source for Linux packages', () => {
    expect(electronBuilderConfig.linux.icon).toBe('resources/build/icon.icns')
  })

  it('matches the Linux desktop entry to Electron window class', () => {
    expect(electronBuilderConfig.linux.desktop.entry.StartupWMClass).toBe('orca')
  })

  it('uses AppImage and deb as local Linux targets without changing existing artifact names', () => {
    expect(electronBuilderConfig.linux.target).toEqual(['AppImage', 'deb'])
    expect(electronBuilderConfig.appImage.artifactName).toBe('orca-linux.${ext}')
    expect(electronBuilderConfig.deb.artifactName).toBe('orca-ide_${version}_${arch}.${ext}')
    expect(electronBuilderConfig.rpm).toMatchObject({
      packageName: 'orca-ide',
      artifactName: 'orca-ide-${version}.${arch}.${ext}'
    })
  })

  it('uses a distinct AppImage name for Linux arm64 release uploads', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const original = process.env.ORCA_LINUX_ARM64_RELEASE
    try {
      delete require.cache[configPath]
      process.env.ORCA_LINUX_ARM64_RELEASE = '1'
      expect(require('../electron-builder.config.cjs').appImage.artifactName).toBe(
        'orca-linux-arm64.${ext}'
      )
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_LINUX_ARM64_RELEASE
      } else {
        process.env.ORCA_LINUX_ARM64_RELEASE = original
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  it('uses Orca native rebuild hook instead of electron-builder default rebuild', () => {
    expect(electronBuilderConfig.beforeBuild).toBe(electronBuilderNativeRebuild)
    expect(electronBuilderConfig.npmRebuild).toBe(true)
  })

  it('verifies packaged main runtime deps from Windows-style asar entries', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-deps-'))
    try {
      await writeFile(join(resourcesDir, 'app.asar'), '', 'utf8')
      await mkdir(join(resourcesDir, 'node_modules', 'yaml'), { recursive: true })
      await mkdir(join(resourcesDir, 'node_modules', 'zod'), { recursive: true })

      const sources = new Map([
        ['out\\main\\index.js', 'const z = require("zod")'],
        ['out\\main\\agent-hooks\\managed-agent-hook-controls.js', 'const YAML = require("yaml")']
      ])
      const asar = {
        listPackage: () => [...sources.keys()].map((entry) => `\\${entry}`),
        extractFile: (_asarPath, internalPath) => Buffer.from(sources.get(internalPath), 'utf8')
      }

      expect(() => verifyPackagedMainRuntimeDeps(resourcesDir, asar)).not.toThrow()
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('normalizes host-specific asar entry separators', () => {
    expect(findAsarEntry(['\\out\\main\\index.js'], 'out/main/index.js')).toBe(
      '\\out\\main\\index.js'
    )
    expect(findAsarEntry(['/out/main/index.js'], 'out/main/index.js')).toBe('/out/main/index.js')
  })

  it('prunes non-target node-pty prebuilds from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-node-pty-prune-'))
    try {
      const prebuildsDir = join(resourcesDir, 'node_modules', 'node-pty', 'prebuilds')
      await mkdir(join(prebuildsDir, 'darwin-arm64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'darwin-x64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'linux-x64'), { recursive: true })
      await mkdir(join(prebuildsDir, 'win32-x64'), { recursive: true })
      await mkdir(join(resourcesDir, 'node_modules', 'node-pty', 'third_party', 'conpty'), {
        recursive: true
      })
      await mkdir(join(resourcesDir, 'node_modules', 'node-pty', 'deps', 'winpty'), {
        recursive: true
      })

      prunePackagedNodePty(resourcesDir, 'darwin')

      await expect(readdir(prebuildsDir).then((entries) => entries.sort())).resolves.toEqual([
        'darwin-arm64',
        'darwin-x64'
      ])
      await expect(
        readdir(join(resourcesDir, 'node_modules', 'node-pty', 'third_party'))
      ).resolves.toEqual([])
      await expect(
        readdir(join(resourcesDir, 'node_modules', 'node-pty', 'deps'))
      ).resolves.toEqual([])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('copies the Windows node-pty ConPTY runtime beside the rebuilt addon', async () => {
    for (const arch of ['x64', 'arm64']) {
      const resourcesDir = await mkdtemp(join(tmpdir(), `orca-node-pty-conpty-${arch}-`))
      try {
        const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
        const releaseDir = join(nodePtyDir, 'build', 'Release')
        const conptyRoot = join(nodePtyDir, 'third_party', 'conpty', '0.1.0')
        await mkdir(releaseDir, { recursive: true })
        await writeFile(join(releaseDir, 'conpty.node'), 'native addon placeholder', 'utf8')
        for (const sourceArch of ['x64', 'arm64']) {
          const sourceDir = join(conptyRoot, `win10-${sourceArch}`)
          await mkdir(sourceDir, { recursive: true })
          await writeFile(join(sourceDir, 'conpty.dll'), `dll payload ${sourceArch}`, 'utf8')
          await writeFile(
            join(sourceDir, 'OpenConsole.exe'),
            `console payload ${sourceArch}`,
            'utf8'
          )
        }

        prunePackagedNodePty(resourcesDir, 'win32', arch)

        await expect(readFile(join(releaseDir, 'conpty', 'conpty.dll'), 'utf8')).resolves.toBe(
          `dll payload ${arch}`
        )
        await expect(readFile(join(releaseDir, 'conpty', 'OpenConsole.exe'), 'utf8')).resolves.toBe(
          `console payload ${arch}`
        )
      } finally {
        await rm(resourcesDir, { recursive: true, force: true })
      }
    }
  })

  it('includes @parcel/watcher in the packaged runtime closure', () => {
    // Why: the main process imports '@parcel/watcher' for filesystem change
    // events; if it is absent from the packaged closure the serve host silently
    // stops propagating file changes to clients (regression guard for #4851).
    const packaged = createPackagedRuntimeNodeModuleResources()
    const packagedTargets = packaged.map((resource) => resource.to)
    expect(packagedTargets).toContain(join('node_modules', '@parcel', 'watcher'))
    expect(
      packagedTargets.some((target) =>
        target.startsWith(join('node_modules', '@parcel', 'watcher-'))
      )
    ).toBe(true)
  })

  it('prunes non-target @parcel/watcher platform subpackages from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-parcel-watcher-prune-'))
    try {
      const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
      await mkdir(join(parcelDir, 'watcher'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-arm64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-x64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-x64-glibc'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-arm64-glibc'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-win32-x64'), { recursive: true })

      prunePackagedParcelWatcher(resourcesDir, 'linux')

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'watcher',
        'watcher-linux-arm64-glibc',
        'watcher-linux-x64-glibc'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('leaves unrelated @parcel/* runtime deps untouched when pruning the watcher', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-parcel-watcher-prune-unrelated-'))
    try {
      const parcelDir = join(resourcesDir, 'node_modules', '@parcel')
      await mkdir(join(parcelDir, 'watcher'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-darwin-arm64'), { recursive: true })
      await mkdir(join(parcelDir, 'watcher-linux-x64-glibc'), { recursive: true })
      // A hypothetical future @parcel/* runtime dep that is NOT a watcher subpackage.
      await mkdir(join(parcelDir, 'transformer-js'), { recursive: true })

      prunePackagedParcelWatcher(resourcesDir, 'linux')

      await expect(readdir(parcelDir).then((entries) => entries.sort())).resolves.toEqual([
        'transformer-js',
        'watcher',
        'watcher-linux-x64-glibc'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('prunes type declaration artifacts from packaged runtime node_modules', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-runtime-type-prune-'))
    try {
      const packageDir = join(resourcesDir, 'node_modules', 'example-package')
      await mkdir(join(packageDir, 'dist'), { recursive: true })
      await writeFile(join(packageDir, 'dist', 'index.cjs'), 'module.exports = {}', 'utf8')
      await writeFile(join(packageDir, 'dist', 'index.d.ts'), 'export type Value = string', 'utf8')
      await writeFile(join(packageDir, 'dist', 'index.d.cts'), 'export type Value = string', 'utf8')
      await writeFile(join(packageDir, 'dist', 'index.d.mts.map'), '{}', 'utf8')

      prunePackagedRuntimeTypeDeclarations(resourcesDir)

      await expect(readdir(join(packageDir, 'dist'))).resolves.toEqual(['index.cjs'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('prunes duplicate darwin sherpa-onnx runtime dylib aliases', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-sherpa-prune-'))
    try {
      const packageDir = join(resourcesDir, 'node_modules', 'sherpa-onnx-darwin-arm64')
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'sherpa-onnx.node'), '', 'utf8')
      await writeFile(join(packageDir, 'libonnxruntime.1.23.2.dylib'), '', 'utf8')
      await writeFile(join(packageDir, 'libonnxruntime.dylib'), '', 'utf8')

      prunePackagedSherpaOnnx(resourcesDir, 'darwin')

      await expect(readdir(packageDir).then((entries) => entries.sort())).resolves.toEqual([
        'libonnxruntime.1.23.2.dylib',
        'sherpa-onnx.node'
      ])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('prunes zod TypeScript sources from packaged runtime resources', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-zod-prune-'))
    try {
      const packageDir = join(resourcesDir, 'node_modules', 'zod')
      await mkdir(join(packageDir, 'src'), { recursive: true })
      await writeFile(join(packageDir, 'index.cjs'), 'module.exports = {}', 'utf8')
      await writeFile(join(packageDir, 'src', 'index.ts'), 'export const value = true', 'utf8')

      prunePackagedZodSources(resourcesDir)

      await expect(readdir(packageDir)).resolves.toEqual(['index.cjs'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'marks packaged Unix CLI launchers executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-config-'))
      try {
        const resourcesDir = join(root, 'linux-unpacked', 'resources')
        const launcherPath = join(resourcesDir, 'bin', 'orca-ide')
        await mkdir(join(resourcesDir, 'bin'), { recursive: true })
        await mkdir(join(resourcesDir, 'node_modules', 'zod', 'src'), { recursive: true })
        await writeFile(launcherPath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o644 })

        await electronBuilderConfig.afterPack({
          appOutDir: join(root, 'linux-unpacked'),
          electronPlatformName: 'linux'
        })

        expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
