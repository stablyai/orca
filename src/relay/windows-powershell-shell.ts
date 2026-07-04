import { win32 as pathWin32 } from 'node:path'
import { resolveWindowsPowerShellSpawnChain } from '../main/providers/windows-powershell-executable'

function readPathEnv(env: NodeJS.ProcessEnv): string {
  return env.PATH || env.Path || env.path || ''
}

function getPowerShellFamily(shellPath: string): 'powershell.exe' | 'pwsh.exe' | null {
  const shellName = pathWin32.basename(shellPath).toLowerCase()
  if (shellName === 'pwsh.exe' || shellName === 'pwsh') {
    return 'pwsh.exe'
  }
  if (shellName === 'powershell.exe' || shellName === 'powershell') {
    return 'powershell.exe'
  }
  return null
}

function getEnvWithShellDirectory(env: NodeJS.ProcessEnv, shellPath: string): NodeJS.ProcessEnv {
  if (!pathWin32.isAbsolute(shellPath)) {
    return env
  }
  const shellDir = pathWin32.dirname(shellPath)
  const pathValue = readPathEnv(env)
  return {
    ...env,
    PATH: pathValue ? `${shellDir}${pathWin32.delimiter}${pathValue}` : shellDir
  }
}

export function resolveWindowsPowerShellShellPath(
  shellPath: string,
  env: NodeJS.ProcessEnv = process.env,
  existsPath?: (path: string) => boolean
): string | null {
  const family = getPowerShellFamily(shellPath)
  if (!family) {
    return null
  }
  const resolveEnv = getEnvWithShellDirectory(env, shellPath)
  const chain = resolveWindowsPowerShellSpawnChain(family, {
    env: resolveEnv,
    platform: 'win32',
    ...(existsPath ? { isRealExecutable: existsPath } : {})
  })
  return chain[0] ?? null
}
