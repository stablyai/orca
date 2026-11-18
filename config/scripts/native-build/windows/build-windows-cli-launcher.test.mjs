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
import { runProcessSync } from '@orca/process-host'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const projectRoot = resolve(import.meta.dirname, '../../../..')
const WINDOWS_LOCK_CODES = ['EBUSY', 'ENOTEMPTY', 'EPERM']

// Windows image/AV locks can outlast exit; retry cleanup then retain temp tree rather than fail launcher assertions.
function removeFixtureTree(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    if (process.platform !== 'win32' || !WINDOWS_LOCK_CODES.includes(error?.code)) {
      throw error
    }
  }
}
// Cold Cargo compile/link exceeds unit timeout on hosted Windows; subsequent cases reuse target output.
function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 300_000 }, test)
}

let sharedLauncherRoot = null
let sharedLauncherPath = null

// Compile once; each launch case gets a private copy so it can own its fixture tree.
beforeAll(() => {
  if (process.platform !== 'win32') {
    return
  }
  sharedLauncherRoot = mkdtempSync(join(tmpdir(), 'orca cli launcher build '))
  sharedLauncherPath = join(sharedLauncherRoot, 'orca.exe')
  const result = runProcessSync({
    program: process.execPath,
    args: ['config/scripts/native-build/windows/build-windows-cli-launcher.mjs'],
    cwd: projectRoot,
    timeoutMs: 300_000
  })
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

  itWindows(
    'keeps workspace-choice data in one argv value through native and supported PowerShell modes',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca choice native argv '))
      try {
        const launcher = join(root, 'bin', 'orca.exe')
        const entry = join(root, 'argv.cjs')
        const script = join(root, 'choice.ps1')
        writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
        copySharedLauncher(launcher)
        writeFileSync(
          join(dirname(launcher), 'orca-launcher.cfg'),
          `node=${process.execPath}\ncli=${entry}\nuser-data=${root}\n`
        )
        writeFileSync(
          script,
          [
            '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
            '$PSNativeCommandArgumentPassing = $env:ORCA_CHOICE_MODE',
            '& $env:ORCA_CHOICE_LAUNCHER worktree show --worktree $env:ORCA_CHOICE_SELECTOR --json',
            'exit $LASTEXITCODE'
          ].join('\n')
        )
        const selectors = [
          'id:repo::C:\\space path\\child',
          'id:repo::C:\\quotes" and smart“quotes”',
          'id:repo::C:\\semi;&$`%!^()',
          'id:repo::C:\\back\\slash/',
          'id:repo::C:\\line\nfeed',
          'id:repo::C:\\cafe\u0301',
          'id:repo::C:\\trailing\\'
        ]
        for (const selector of selectors) {
          const argv = ['worktree', 'show', '--worktree', selector, '--json']
          const native = runProcessSync({ program: launcher, args: argv })
          expect(native.code, native.stderr).toBe(0)
          expect(JSON.parse(native.stdout)).toEqual(argv)
          for (const [program, mode] of [
            ['powershell.exe', 'Legacy'],
            ['pwsh.exe', 'Standard'],
            ['pwsh.exe', 'Legacy']
          ]) {
            // Legacy native argument passing itself drops embedded quotes; no universal shell recipe is promised.
            if (mode === 'Legacy' && selector.includes('"')) {
              continue
            }
            const result = runProcessSync({
              program,
              args: ['-NoProfile', '-NonInteractive', '-File', script],
              env: {
                ...process.env,
                ORCA_CHOICE_MODE: mode,
                ORCA_CHOICE_LAUNCHER: launcher,
                ORCA_CHOICE_SELECTOR: selector
              }
            })
            expect(result.code, `${program}/${mode}: ${result.stderr}`).toBe(0)
            expect(JSON.parse(result.stdout)).toEqual(argv)
          }
        }
      } finally {
        removeFixtureTree(root)
      }
    }
  )

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
        'native-build',
        'windows',
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
