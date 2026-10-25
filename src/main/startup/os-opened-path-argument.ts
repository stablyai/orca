import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function localPathFromArgument(argument: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (argument.startsWith('file://')) {
    try {
      // Why the explicit windows flag: this must decode the same way on any host so the
      // behaviour is testable, and it is what turns `file://server/share` back into a UNC path.
      return fileURLToPath(argument, { windows: platform === 'win32' })
    } catch {
      return null
    }
  }
  return pathApi.isAbsolute(argument) ? argument : null
}
