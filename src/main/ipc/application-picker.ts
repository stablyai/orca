import { dialog } from 'electron'
import type { ShellPickedApplication } from '../../shared/shell-open-types'
import { buildOpenWithCommand, deriveOpenWithLabel } from '../../shared/open-with-applications'

/**
 * Points the picker at the platform's app location and filters to launchable
 * targets. macOS keeps `openFile` so the panel hands back the .app bundle
 * itself instead of descending into Contents/.
 */
function applicationPickerOptions(): Electron.OpenDialogOptions {
  if (process.platform === 'darwin') {
    return {
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['app'] }]
    }
  }
  if (process.platform === 'win32') {
    return {
      defaultPath: process.env.ProgramFiles,
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe', 'cmd', 'bat', 'com'] }]
    }
  }
  return {
    defaultPath: '/usr/share/applications',
    properties: ['openFile'],
    filters: [
      { name: 'Applications', extensions: ['desktop', 'AppImage'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

/**
 * Registering an app by picking it beats asking users to know its CLI name —
 * most GUI apps (Preview, Typora) don't ship one at all.
 */
export async function pickApplicationForOpenWith(): Promise<ShellPickedApplication | null> {
  const result = await dialog.showOpenDialog(applicationPickerOptions())
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const applicationPath = result.filePaths[0]
  const command = buildOpenWithCommand(applicationPath, process.platform)
  if (!command) {
    return null
  }
  return { applicationPath, command, label: deriveOpenWithLabel(applicationPath) }
}
