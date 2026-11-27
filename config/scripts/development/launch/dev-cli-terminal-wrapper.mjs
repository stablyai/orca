import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting.ts'

function escapeWindowsBatchValue(value) {
  // Why: cmd.exe expands %NAME% even inside quotes, so literal path percent signs must be doubled.
  return value.replaceAll('%', '%%')
}

export function prepareDevCliTerminalWrappers({
  repoRoot,
  userDataPath,
  electronExecutable,
  platform = process.platform
}) {
  const binDir = path.join(repoRoot, 'out', 'bin')
  const userDataBinDir = path.join(userDataPath, 'cli', 'bin')
  const cliPath = path.join(repoRoot, 'out', 'cli', 'index.js')
  const commandNames = ['orca-dev', 'orca']
  mkdirSync(binDir, { recursive: true })
  mkdirSync(userDataBinDir, { recursive: true })

  if (platform === 'win32') {
    const wrapperContent = `@echo off\r\nset "ORCA_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"\r\nset "ORCA_DEV_CLI_INVOCATION=1"\r\nset "ORCA_APP_EXECUTABLE=${escapeWindowsBatchValue(electronExecutable)}"\r\nset "ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1"\r\nnode "${escapeWindowsBatchValue(cliPath)}" %*\r\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of commandNames) {
        writeFileSync(path.join(targetDir, `${commandName}.cmd`), wrapperContent, 'utf8')
      }
    }
  }

  const shellWrapper = `#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH=${quotePosixShell(userDataPath)}\nexport ORCA_DEV_CLI_INVOCATION=1\nexport ORCA_APP_EXECUTABLE=${quotePosixShell(electronExecutable)}\nexport ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1\nexec node ${quotePosixShell(cliPath)} "$@"\n`
  // Git Bash looks for the bare command in the prepended profile directory.
  const shellDirs = platform === 'win32' ? [userDataBinDir] : [binDir, userDataBinDir]
  for (const targetDir of shellDirs) {
    for (const commandName of commandNames) {
      const wrapperPath = path.join(targetDir, commandName)
      writeFileSync(wrapperPath, shellWrapper, 'utf8')
      chmodSync(wrapperPath, 0o755)
    }
  }

  return { binDir, userDataBinDir }
}
