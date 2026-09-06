import { lstatSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

export function canSkipAgentBrowserSessionReset(options: {
  platform: NodeJS.Platform
  ownsSocketDirectory: boolean
  socketDirectory: string | undefined
  sessionName: string
}): boolean {
  const { socketDirectory, sessionName } = options
  if (
    options.platform === 'win32' ||
    !options.ownsSocketDirectory ||
    !socketDirectory ||
    !isAbsolute(socketDirectory) ||
    !sessionName ||
    basename(sessionName) !== sessionName
  ) {
    return false
  }
  try {
    lstatSync(join(socketDirectory, `${sessionName}.sock`))
    return false
  } catch (error) {
    // An absent owned socket cannot be reused; permission and other failures prove nothing.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
