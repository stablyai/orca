import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

const PROGRAMS_PATH_BRIDGE_NAME = 'orca-programs-path.exe'

let cachedProgramsPath: string | undefined

export function getWindowsProgramsPath(): string {
  if (cachedProgramsPath) {
    return cachedProgramsPath
  }

  const bridgePath = win32.join(process.resourcesPath, 'bin', PROGRAMS_PATH_BRIDGE_NAME)
  const programsPath = execFileSync(bridgePath, {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
  if (!win32.isAbsolute(programsPath)) {
    throw new Error(`SHGetKnownFolderPath returned an invalid Programs path: ${programsPath}`)
  }

  // Why: Programs can be redirected independently of APPDATA; cache the Shell
  // result so repeated icon changes do not repeatedly launch the native bridge.
  cachedProgramsPath = programsPath
  return programsPath
}
