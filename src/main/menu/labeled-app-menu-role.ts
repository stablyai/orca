import { translateMain } from '../i18n/main-i18n'

export function labeledAppMenuRole(
  role: Electron.MenuItemConstructorOptions['role'],
  key: string,
  fallback: string
): Electron.MenuItemConstructorOptions {
  return { role, label: translateMain(key, fallback) }
}
