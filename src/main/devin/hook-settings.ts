import { homedir } from 'os'
import { join } from 'path'
import {
  getSharedManagedScriptPath,
  wrapPosixHookCommand
} from '../agent-hooks/installer-utils'

const DEVIN_SCRIPT_BASE = 'devin-hook'

export function getDevinConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'devin', 'config.json')
  }
  return join(homedir(), '.config', 'devin', 'config.json')
}

export function getDevinManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${DEVIN_SCRIPT_BASE}.cmd` : `${DEVIN_SCRIPT_BASE}.sh`
}

export function getDevinPosixManagedScriptFileName(): string {
  return `${DEVIN_SCRIPT_BASE}.sh`
}

export function getDevinManagedScriptPath(): string {
  return getSharedManagedScriptPath(getDevinManagedScriptFileName())
}

export function getDevinRemoteConfigPath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.config/devin/config.json`
}

export function getDevinManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    // Why: Devin documents Claude Code–compatible hooks; forward slashes survive Git Bash on Windows.
    return scriptPath.replaceAll('\\', '/')
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getDevinRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}