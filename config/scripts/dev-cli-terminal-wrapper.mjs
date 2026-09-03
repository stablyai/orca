import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
  const subCliPath = path.join(repoRoot, 'config', 'scripts', 'orca-sub.mjs')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(userDataBinDir, { recursive: true })

  if (platform === 'win32') {
    const commonEnv = `@echo off\r\nset "ORCA_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"\r\nset "ORCA_DEV_CLI_INVOCATION=1"\r\nset "ORCA_APP_EXECUTABLE=${escapeWindowsBatchValue(electronExecutable)}"\r\nset "ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1"\r\n`
    const wrapperContent = `${commonEnv}node "${escapeWindowsBatchValue(cliPath)}" %*\r\n`
    const subWrapperContent = `${commonEnv}node "${escapeWindowsBatchValue(subCliPath)}" %*\r\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['orca-dev.cmd', 'orca.cmd']) {
        writeFileSync(path.join(targetDir, commandName), wrapperContent, 'utf8')
      }
      writeFileSync(path.join(targetDir, 'orca-sub.cmd'), subWrapperContent, 'utf8')
    }
  } else {
    const commonEnv = `#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH=${JSON.stringify(userDataPath)}\nexport ORCA_DEV_CLI_INVOCATION=1\nexport ORCA_APP_EXECUTABLE=${JSON.stringify(electronExecutable)}\nexport ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1\n`
    const wrapperContent = `${commonEnv}exec node ${JSON.stringify(cliPath)} "$@"\n`
    const subWrapperContent = `${commonEnv}exec node ${JSON.stringify(subCliPath)} "$@"\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['orca-dev', 'orca']) {
        const wrapperPath = path.join(targetDir, commandName)
        writeFileSync(wrapperPath, wrapperContent, 'utf8')
        chmodSync(wrapperPath, 0o755)
      }
      const subWrapperPath = path.join(targetDir, 'orca-sub')
      writeFileSync(subWrapperPath, subWrapperContent, 'utf8')
      chmodSync(subWrapperPath, 0o755)
    }
  }

  return { binDir, userDataBinDir }
}
