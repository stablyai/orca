#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const checks = [
  {
    name: 'macOS Swift renderer/provider tests',
    command: 'swift',
    args: ['test', '--package-path', 'native/computer-use-macos'],
    enabled: process.platform === 'darwin'
  },
  {
    name: 'Linux provider Python syntax',
    command: 'python3',
    args: ['-m', 'py_compile', 'native/computer-use-linux/runtime.py'],
    enabled: true
  },
  {
    name: 'Linux provider imports',
    command: 'python3',
    args: [
      '-c',
      [
        'import importlib.util',
        'spec=importlib.util.spec_from_file_location("orca_linux","native/computer-use-linux/runtime.py")',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'print("import-ok")'
      ].join(';')
    ],
    enabled: process.platform === 'linux'
  },
  {
    name: 'Windows provider PowerShell parse',
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      [
        '$errors=$null',
        '$tokens=$null',
        '[System.Management.Automation.Language.Parser]::ParseFile("native/computer-use-windows/runtime.ps1",[ref]$tokens,[ref]$errors) > $null',
        'if ($errors.Count) { $errors | Format-List *; exit 1 }',
        '"parse-ok"'
      ].join('; ')
    ],
    enabled: true
  },
  {
    name: 'Windows provider handshake',
    run: verifyWindowsProviderHandshake,
    enabled: process.platform === 'win32'
  },
  {
    name: 'macOS helper app bundle and signature',
    run: verifyMacOSHelperApp,
    enabled: process.platform === 'darwin'
  }
]

let failed = false
for (const check of checks) {
  if (!check.enabled) {
    console.log(`[computer-native] skip ${check.name}`)
    continue
  }
  if (check.run) {
    console.log(`[computer-native] ${check.name}`)
    if (!check.run()) {
      failed = true
    }
    continue
  }
  if (!hasCommand(check.command)) {
    console.log(`[computer-native] skip ${check.name}: ${check.command} not found`)
    continue
  }
  console.log(`[computer-native] ${check.name}`)
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (result.status !== 0 || result.error) {
    failed = true
  }
}

if (failed) {
  process.exit(1)
}

function hasCommand(command) {
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], { stdio: 'ignore' })
    return result.status === 0
  }
  if (existsSync(command)) {
    return true
  }
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${quoteShell(command)}`], {
    stdio: 'ignore'
  })
  return result.status === 0
}

function verifyMacOSHelperApp() {
  const appPath = join(
    repoRoot,
    'native',
    'computer-use-macos',
    '.build',
    'release',
    'Orca Computer Use.app'
  )
  if (!existsSync(appPath)) {
    console.error(
      `[computer-native] missing helper app at ${appPath}; run pnpm build:computer-macos`
    )
    return false
  }
  return run('codesign', ['--verify', '--deep', '--strict', appPath])
}

function verifyWindowsProviderHandshake() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-computer-use-verify-'))
  const operationPath = join(dir, 'operation.json')
  try {
    writeFileSync(operationPath, JSON.stringify({ tool: 'handshake' }), { mode: 0o600 })
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'native/computer-use-windows/runtime.ps1',
        operationPath
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    if (result.status !== 0 || result.error) {
      process.stderr.write(result.stderr ?? '')
      return false
    }
    const response = JSON.parse(result.stdout.trim())
    if (response.ok === true && response.capabilities?.protocolVersion === 1) {
      console.log('[computer-native] windows-handshake-ok')
      return true
    }
    console.error(`[computer-native] invalid Windows handshake response: ${result.stdout}`)
    return false
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(command, args) {
  if (!hasCommand(command)) {
    console.log(`[computer-native] skip ${command}: command not found`)
    return true
  }
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  return result.status === 0 && !result.error
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
