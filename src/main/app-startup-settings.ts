import { app } from 'electron'
import type { AppStartupSettings } from '../shared/app-startup-types'

type LoginItemApp = Pick<Electron.App, 'getLoginItemSettings' | 'setLoginItemSettings'> & {
  isPackaged: boolean
}

type AppStartupEnvironment = {
  platform: NodeJS.Platform
  executablePath: string
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

function getLoginItemOptions(
  environment: AppStartupEnvironment
): Electron.LoginItemSettingsOptions | undefined {
  return environment.platform === 'win32'
    ? { path: environment.executablePath, args: [] }
    : undefined
}

export function getAppStartupSettings(
  loginItemApp: LoginItemApp = app,
  environment: AppStartupEnvironment = {
    platform: process.platform,
    executablePath: process.execPath
  }
): AppStartupSettings {
  const supported = isSupportedPlatform(environment.platform)
  const canModify = supported && loginItemApp.isPackaged
  if (!canModify) {
    return { supported, canModify, openAtLogin: false }
  }

  const settings = loginItemApp.getLoginItemSettings(getLoginItemOptions(environment))
  const openAtLogin =
    environment.platform === 'win32'
      ? (settings.executableWillLaunchAtLogin ?? settings.openAtLogin)
      : settings.openAtLogin

  return { supported, canModify, openAtLogin }
}

export function setAppStartupSettings(
  openAtLogin: boolean,
  loginItemApp: LoginItemApp = app,
  environment: AppStartupEnvironment = {
    platform: process.platform,
    executablePath: process.execPath
  }
): AppStartupSettings {
  const current = getAppStartupSettings(loginItemApp, environment)
  if (!current.canModify) {
    throw new Error('Launch at login is only available in the installed desktop app.')
  }

  loginItemApp.setLoginItemSettings({
    openAtLogin,
    ...getLoginItemOptions(environment)
  })
  return getAppStartupSettings(loginItemApp, environment)
}
