import { platform } from 'node:process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

export function getHerdrDataDir(): string {
  if (platform === 'win32') {
    return join(process.env.APPDATA ?? '', 'herdr')
  }
  const override = process.env.HERDR_DATA_DIR?.trim()
  if (override) {
    return override
  }
  return join(homedir(), '.local', 'share', 'herdr')
}

export function getDefaultShell(): string {
  if (platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe'
  }
  return process.env.SHELL ?? '/bin/bash'
}

export function getDefaultShellArgs(_shell: string): string[] {
  if (platform === 'win32') {
    return []
  }
  return ['-l']
}

export function getSessionDir(dataDir: string, sessionName: string): string {
  return join(dataDir, 'sessions', sessionName)
}

export function getPanePtyPath(paneId: string): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\herdr-pane-${paneId}`
  }
  return `/tmp/herdr-pane-${paneId}.sock`
}

export function createDataDirs(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'sessions'), { recursive: true })
}
