import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runProcessSync } from '@orca/process-host'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  shouldReuseCompiledWindowsRustExecutable,
  windowsRustExecutableFileVersion,
  windowsRustExecutableTarget,
  windowsRustExecutableFingerprint
} from './windows-rust-executable-build.mjs'
import { findDynamicVcRuntimeImports, readPeImportedDllNames } from './windows-pe-imports.mjs'

const itCrossHost = process.platform === 'win32' ? it.skip : it
const projectRoot = resolve(import.meta.dirname, '../..')
const WINDOWS_LOCK_CODES = ['EBUSY', 'ENOTEMPTY', 'EPERM']

// Why: Windows releases the image handle on a just-executed exe (and finishes the
// AV scan of the freshly compiled one) after the process exits, so tearing down the
// fixture races those locks. Retry, then leave the temp tree rather than reporting a
// teardown lock as a launcher failure.
function removeFixtureTree(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    if (process.platform !== 'win32' || !WINDOWS_LOCK_CODES.includes(error?.code)) {
      throw error
    }
  }
}
// Why: a cold cargo build compiles the resource crate and links from scratch,
// which far exceeds Vitest's 5s unit budget on a hosted Windows runner. Later
// cases reuse the shared target directory, so only the first pays it.
function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 300_000 }, test)
}

let sharedLauncherRoot = null
let sharedLauncherPath = null
let sharedLauncherBuild = null

// Compile once; each launch case gets a private copy so it can own its fixture tree.
beforeAll(() => {
  if (process.platform !== 'win32') {
    return
  }
  sharedLauncherRoot = mkdtempSync(join(tmpdir(), 'orca cli launcher build '))
  sharedLauncherPath = join(sharedLauncherRoot, 'orca.exe')
  const result = runProcessSync({
    program: process.execPath,
    args: ['config/scripts/build-windows-cli-launcher.mjs'],
    cwd: projectRoot,
    timeoutMs: 300_000
  })
  sharedLauncherBuild = { status: result.code, stdout: result.stdout, stderr: result.stderr }
  if (result.code !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`)
  }
  copyFileSync(
    join(projectRoot, 'native', 'windows-cli-launcher', '.build', 'orca.exe'),
    sharedLauncherPath
  )
}, 300_000)

afterAll(() => {
  if (sharedLauncherRoot) {
    removeFixtureTree(sharedLauncherRoot)
  }
})

function copySharedLauncher(target) {
  if (!sharedLauncherPath) {
    throw new Error('shared Windows CLI launcher was not built')
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(sharedLauncherPath, target)
}

describe('Windows CLI launcher', () => {
  itWindows('reuses the hook host target while invalidating changed inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hook-target-'))
    try {
      const hookScript = join('config', 'scripts', 'build-windows-agent-hook.mjs')
      const crate = join('native', 'windows-agent-hook')
      const outputFile = join(crate, '.build', 'orca-agent-hook.exe')
      const outputPath = join(root, outputFile)
      const fingerprintPath = `${outputPath}.sha256`
      // Why the default output: it reuses a warm canonical prebuild; Cargo runs only when that is missing or stale.
      const first = runProcessSync({
        program: process.execPath,
        args: [hookScript],
        cwd: projectRoot,
        timeoutMs: 300_000
      })
      expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0)
      for (const file of [
        outputFile,
        `${outputFile}.sha256`,
        'package.json',
        hookScript,
        join('config', 'scripts', 'windows-rust-executable-build.mjs'),
        join('config', 'scripts', 'windows-pe-imports.mjs'),
        join('resources', 'build', 'icon.ico'),
        ...[
          'src/main.rs',
          'build.rs',
          'Cargo.toml',
          'Cargo.lock',
          'app.manifest',
          '.cargo/config.toml'
        ].map((file) => join(crate, ...file.split('/')))
      ]) {
        mkdirSync(dirname(join(root, file)), { recursive: true })
        copyFileSync(join(projectRoot, file), join(root, file))
      }
      const fingerprint = readFileSync(fingerprintPath, 'utf8')
      const binary = readFileSync(outputPath)
      // A reuse hit must succeed even when Cargo is unavailable.
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')
      )
      environment.PATH = ''
      const invoke = (args = []) =>
        runProcessSync({
          program: process.execPath,
          args: [hookScript, ...args],
          cwd: root,
          env: environment,
          timeoutMs: 10_000
        })
      for (const args of [[], ['--arch', process.arch]]) {
        const reused = invoke(args)
        expect(reused.code, `${reused.stdout}\n${reused.stderr}`).toBe(0)
        expect(reused.stdout).toContain('reusing Windows agent hook')
        expect(readFileSync(fingerprintPath, 'utf8')).toBe(fingerprint)
        expect(readFileSync(outputPath)).toEqual(binary)
      }
      const otherArchitecture = process.arch === 'x64' ? 'arm64' : 'x64'
      const crossTarget = invoke(['--arch', otherArchitecture])
      expect(crossTarget.code).not.toBe(0)
      expect(crossTarget.stderr).toContain('Unable to run cargo')
      const unsupported = invoke(['--arch', 'ia32'])
      expect(unsupported.code).not.toBe(0)
      expect(unsupported.stderr).toContain('Unsupported Windows executable architecture: ia32')
      for (const file of [join(crate, 'src', 'main.rs'), 'package.json']) {
        const path = join(root, file)
        const original = readFileSync(path, 'utf8')
        writeFileSync(fingerprintPath, fingerprint)
        writeFileSync(
          path,
          file === 'package.json'
            ? JSON.stringify({ ...JSON.parse(original), version: '99.0.0' })
            : `${original}\n// changed fixture source\n`
        )
        const changed = invoke()
        expect(changed.code).not.toBe(0)
        expect(changed.stderr).toContain('Unable to run cargo')
        writeFileSync(path, original)
      }
      writeFileSync(fingerprintPath, fingerprint)
      expect(invoke().code).toBe(0)
    } finally {
      removeFixtureTree(root)
    }
  })

  it('reuses restored builds only while all embedded inputs and the release version match', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cli-launcher-reuse-'))
    try {
      const inputs = ['main.rs', 'build.rs', 'Cargo.toml', 'app.manifest', 'icon.ico'].map(
        (name) => {
          const path = join(root, name)
          writeFileSync(path, name)
          return path
        }
      )
      const outputPath = join(root, 'orca.exe')
      const fingerprint = windowsRustExecutableFingerprint(inputs, '1.4.214')
      expect(shouldReuseCompiledWindowsRustExecutable(outputPath, fingerprint)).toBe(false)
      writeFileSync(outputPath, 'binary')
      expect(shouldReuseCompiledWindowsRustExecutable(outputPath, fingerprint)).toBe(false)
      writeFileSync(`${outputPath}.sha256`, fingerprint)
      for (const input of inputs) {
        utimesSync(input, new Date(), new Date())
      }
      expect(
        shouldReuseCompiledWindowsRustExecutable(
          outputPath,
          windowsRustExecutableFingerprint(inputs, '1.4.214')
        )
      ).toBe(true)
      expect(
        shouldReuseCompiledWindowsRustExecutable(
          outputPath,
          windowsRustExecutableFingerprint(inputs, '1.4.215')
        )
      ).toBe(false)
      for (const input of inputs) {
        const original = readFileSync(input)
        writeFileSync(input, 'changed')
        expect(
          shouldReuseCompiledWindowsRustExecutable(
            outputPath,
            windowsRustExecutableFingerprint(inputs, '1.4.214')
          )
        ).toBe(false)
        writeFileSync(input, original)
      }
    } finally {
      removeFixtureTree(root)
    }
  })

  it('reduces a prerelease to the numeric version Windows can record', () => {
    expect(windowsRustExecutableFileVersion('1.4.214-daily.202609281300')).toBe('1.4.214.0')
    expect(windowsRustExecutableFileVersion('1.4.214')).toBe('1.4.214.0')
    for (const version of ['1.4.65535', '1.4', '1.4.214"', undefined]) {
      expect(() => windowsRustExecutableFileVersion(version)).toThrow('Invalid Windows')
    }
  })

  itWindows(
    'embeds publisher, release version, icon and an unelevated application manifest',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca launcher metadata '))
      try {
        const launcherPath = join(root, 'orca.exe')
        expect(sharedLauncherBuild).not.toBeNull()
        expect(
          sharedLauncherBuild.status,
          `${sharedLauncherBuild.stdout}\n${sharedLauncherBuild.stderr}`
        ).toBe(0)
        copySharedLauncher(launcherPath)
        const inspect = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:ORCA_TEST_LAUNCHER) | ConvertTo-Json -Compress'
          ],
          { encoding: 'utf8', env: { ...process.env, ORCA_TEST_LAUNCHER: launcherPath } }
        )
        expect(inspect.status, inspect.stderr).toBe(0)
        const info = JSON.parse(inspect.stdout)
        const { version } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
        expect(info.CompanyName).toBe('Stably AI')
        expect(info.ProductName).toBe('Orca')
        expect(info.FileDescription).toBe('Orca CLI Launcher')
        expect(info.FileVersion).toBe(`${version.split(/[+-]/)[0]}.0`)
        expect(info.ProductVersion).toBe(version)
        const binary = readFileSync(launcherPath)
        expect(binary.includes(Buffer.from('requestedExecutionLevel level="asInvoker"'))).toBe(true)
        const imports = readPeImportedDllNames(binary)
        expect(imports.map((name) => name.toLowerCase())).toContain('kernel32.dll')
        expect(findDynamicVcRuntimeImports(imports)).toEqual([])
        const icon = readFileSync(join(projectRoot, 'resources', 'build', 'icon.ico'))
        const imageSize = icon.readUInt32LE(14)
        const imageOffset = icon.readUInt32LE(18)
        expect(binary.includes(icon.subarray(imageOffset, imageOffset + imageSize))).toBe(true)
      } finally {
        removeFixtureTree(root)
      }
    }
  )

  itCrossHost('fails closed when the Windows launcher cannot be compiled on this host', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'orca cross-host launcher '))
    try {
      const result = spawnSync(
        process.execPath,
        ['config/scripts/build-windows-cli-launcher.mjs', '--output', join(outputRoot, 'orca.exe')],
        { cwd: projectRoot, encoding: 'utf8' }
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Windows CLI launcher')
      expect(result.stderr).toContain('Windows host')
    } finally {
      removeFixtureTree(outputRoot)
    }
  })

  itWindows('preserves a multiline argument from PowerShell through the native launcher', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'orca cli launcher '))
    try {
      const resourcesPath = join(appRoot, 'resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca.exe')
      const cliPath = join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
      mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
      mkdirSync(dirname(cliPath), { recursive: true })
      copyFileSync(process.execPath, join(appRoot, 'Orca.exe'))
      writeFileSync(
        cliPath,
        `process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  orcaNodeOptions: process.env.ORCA_NODE_OPTIONS ?? null
}))\n`,
        'utf8'
      )

      copySharedLauncher(launcherPath)

      const body = 'paragraph one line one\nparagraph one line two\n\nparagraph two'
      const powershell = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '& $env:ORCA_TEST_LAUNCHER orchestration send --body $env:ORCA_TEST_BODY --json'
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '--no-warnings',
            ORCA_TEST_BODY: body,
            ORCA_TEST_LAUNCHER: launcherPath
          }
        }
      )

      expect(powershell.status, powershell.stderr).toBe(0)
      expect(JSON.parse(powershell.stdout)).toEqual({
        argv: ['orchestration', 'send', '--body', body, '--json'],
        electronRunAsNode: '1',
        nodeOptions: null,
        orcaNodeOptions: '--no-warnings'
      })
    } finally {
      removeFixtureTree(appRoot)
    }
  })

  it('cross-compiles only the architectures the orcad template ships', () => {
    expect(windowsRustExecutableTarget(undefined)).toBeNull()
    expect(windowsRustExecutableTarget('x64')).toBe('x86_64-pc-windows-msvc')
    expect(windowsRustExecutableTarget('arm64')).toBe('aarch64-pc-windows-msvc')
    expect(() => windowsRustExecutableTarget('ia32')).toThrow('Unsupported')
  })

  itWindows('runs a server profile CLI on pinned Node with argv and profile intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca server launcher '))
    try {
      const profile = join(root, 'server profile')
      const launcherPath = join(profile, 'cli', 'bin', 'orca.exe')
      const cliPath = join(root, 'server slot', 'out', 'cli', 'index.js')
      mkdirSync(dirname(cliPath), { recursive: true })
      writeFileSync(
        cliPath,
        `process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  profile: process.env.ORCA_USER_DATA_PATH,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  desktopMarker: process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER ?? null
}))\n`,
        'utf8'
      )
      copySharedLauncher(launcherPath)
      writeFileSync(
        join(dirname(launcherPath), 'orca-launcher.cfg'),
        `node=${process.execPath}\ncli=${cliPath}\nuser-data=${profile}\n`
      )

      const inherited = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require C:\\missing\\preload.js',
        ORCA_USER_DATA_PATH: 'C:\\another\\owner',
        ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER: '1',
        ORCA_TEST_LAUNCHER: launcherPath
      }
      const expected = (body) => ({
        argv: ['orchestration', 'send', '--body', body, '--json'],
        profile,
        electronRunAsNode: null,
        nodeOptions: null,
        desktopMarker: null
      })
      // Windows PowerShell 5.1 itself drops embedded double quotes, so its body has none.
      const shellBody = 'line one & %PATH% ^caret\n\nline three'
      const powershell = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '& $env:ORCA_TEST_LAUNCHER orchestration send --body $env:ORCA_TEST_BODY --json'
        ],
        { encoding: 'utf8', env: { ...inherited, ORCA_TEST_BODY: shellBody } }
      )
      expect(powershell.status, powershell.stderr).toBe(0)
      expect(JSON.parse(powershell.stdout)).toEqual(expected(shellBody))

      const body = 'line one "quoted" \\"escaped\\" & %PATH% ^caret\\\n\nline three\\'
      const direct = spawnSync(launcherPath, expected(body).argv, {
        encoding: 'utf8',
        env: inherited
      })
      expect(direct.status, direct.stderr).toBe(0)
      expect(JSON.parse(direct.stdout)).toEqual(expected(body))
    } finally {
      removeFixtureTree(root)
    }
  })

  itWindows('survives an inherited environment block containing PATH and Path', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'orca duplicate path launcher '))
    try {
      const resourcesPath = join(appRoot, 'resources')
      const launcherPath = join(resourcesPath, 'bin', 'orca.exe')
      const cliPath = join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
      const outputPath = join(appRoot, 'child-result.json')
      const harnessSourcePath = join(
        projectRoot,
        'config',
        'scripts',
        'fixtures',
        'DuplicatePathProcessLauncher.cs'
      )
      const harnessPath = join(appRoot, 'DuplicatePathLauncher.exe')
      mkdirSync(dirname(launcherPath), { recursive: true })
      mkdirSync(dirname(cliPath), { recursive: true })
      copyFileSync(process.execPath, join(appRoot, 'Orca.exe'))
      writeFileSync(
        cliPath,
        `require('node:fs').writeFileSync(process.env.ORCA_TEST_OUTPUT, JSON.stringify({
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  pathKeys: Object.keys(process.env).filter((key) => key.toLowerCase() === 'path')
}))\n`,
        'utf8'
      )
      copySharedLauncher(launcherPath)

      const compiler = findFrameworkCompiler()
      expect(compiler).not.toBeNull()
      const compileHarness = spawnSync(
        compiler,
        ['/nologo', '/target:exe', `/out:${harnessPath}`, harnessSourcePath],
        { encoding: 'utf8' }
      )
      expect(compileHarness.status, `${compileHarness.stdout}\n${compileHarness.stderr}`).toBe(0)

      const launch = spawnSync(harnessPath, [launcherPath, outputPath], { encoding: 'utf8' })
      expect(launch.status, `${launch.stdout}\n${launch.stderr}`).toBe(0)
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
        electronRunAsNode: '1',
        pathKeys: ['PATH', 'Path']
      })
    } finally {
      removeFixtureTree(appRoot)
    }
  })
})

function findFrameworkCompiler() {
  const windowsDirectory = process.env.WINDIR ?? process.env.SystemRoot
  if (!windowsDirectory) {
    return null
  }
  return (
    [
      join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
    ].find((candidate) => existsSync(candidate)) ?? null
  )
}
