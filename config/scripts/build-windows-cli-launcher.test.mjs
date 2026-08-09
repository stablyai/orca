import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

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
// Why: cold csc.exe startup exceeds Vitest's 5s unit budget on hosted Windows;
// keep the larger allowance scoped to the real compiler integration test.
function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 15_000 }, test)
}

describe('Windows CLI launcher', () => {
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

  itCrossHost('never materializes the child environment block from ProcessStartInfo', () => {
    // Why: both ProcessStartInfo env properties copy the process block into a case-insensitive
    // dictionary that throws when the inherited block holds PATH and Path (stablyai/orca#12046).
    const source = readFileSync(
      join(projectRoot, 'native', 'windows-cli-launcher', 'OrcaCliLauncher.cs'),
      'utf8'
    )
    const code = source.replace(/^\s*\/\/.*$/gm, '')

    expect(code).not.toContain('EnvironmentVariables')
    expect(code).not.toContain('startInfo.Environment')
    expect(code).toContain('Environment.SetEnvironmentVariable')
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

      const build = spawnSync(
        process.execPath,
        ['config/scripts/build-windows-cli-launcher.mjs', '--output', launcherPath],
        { cwd: projectRoot, encoding: 'utf8' }
      )
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

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
      const build = spawnSync(
        process.execPath,
        ['config/scripts/build-windows-cli-launcher.mjs', '--output', launcherPath],
        { cwd: projectRoot, encoding: 'utf8' }
      )
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

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
