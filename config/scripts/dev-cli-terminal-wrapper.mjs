import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cliRuntimeFilename } from '../bundled-cli-runtime.cjs'

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function escapeWindowsBatchValue(value) {
  // Why: cmd.exe expands %NAME% even inside quotes, so literal path percent signs must be doubled.
  return value.replaceAll('%', '%%')
}

export function prepareDevCliTerminalWrappers({
  repoRoot,
  userDataPath,
  electronExecutable,
  platform = process.platform,
  arch = process.arch
}) {
  const binDir = path.join(repoRoot, 'out', 'bin')
  const userDataBinDir = path.join(userDataPath, 'cli', 'bin')
  const runtimePath = path.join(
    repoRoot,
    'out',
    'cli-runtime',
    `${platform}-${arch}`,
    cliRuntimeFilename(platform)
  )
  const cliPath = path.join(repoRoot, 'out', 'cli', 'index.js')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(userDataBinDir, { recursive: true })

  if (platform === 'win32') {
    const wrapperContent = `@echo off\r\nset "ORCA_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"\r\nset "ORCA_DEV_CLI_INVOCATION=1"\r\nset "ORCA_APP_EXECUTABLE=${escapeWindowsBatchValue(electronExecutable)}"\r\nset "ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1"\r\nset ELECTRON_RUN_AS_NODE=\r\nset NODE_OPTIONS=\r\nset NODE_REPL_EXTERNAL_MODULE=\r\nset BUN_OPTIONS=\r\n"${escapeWindowsBatchValue(runtimePath)}" --no-env-file --config=NUL --no-install "${escapeWindowsBatchValue(cliPath)}" %*\r\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['orca-dev.cmd', 'orca.cmd']) {
        writeFileSync(path.join(targetDir, commandName), wrapperContent, 'utf8')
      }
    }
  } else {
    const wrapperContent = `#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH=${quoteShell(userDataPath)}\nexport ORCA_DEV_CLI_INVOCATION=1\nexport ORCA_APP_EXECUTABLE=${quoteShell(electronExecutable)}\nexport ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1\nunset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE BUN_OPTIONS\nexec ${quoteShell(runtimePath)} --no-env-file --config=/dev/null --no-install ${quoteShell(cliPath)} "$@"\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['orca-dev', 'orca']) {
        const wrapperPath = path.join(targetDir, commandName)
        writeFileSync(wrapperPath, wrapperContent, 'utf8')
        chmodSync(wrapperPath, 0o755)
      }
    }
  }

  return { binDir, userDataBinDir }
}
