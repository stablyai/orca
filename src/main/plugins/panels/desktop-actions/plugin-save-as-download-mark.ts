import { writeFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'

type DownloadMarkDeps = {
  platform: NodeJS.Platform
  now: () => number
  writeFile: (path: string, data: string) => Promise<void>
  runProcess: typeof runProcess
}

const defaultDeps: DownloadMarkDeps = {
  platform: process.platform,
  now: () => Date.now(),
  writeFile: (path, data) => writeFile(path, data),
  runProcess
}

/**
 * Marks a plugin-saved file as downloaded from the internet, as a browser would, so the OS warns
 * before opening anything a denylist missed. Best effort: FAT volumes have no streams or xattrs.
 * Linux has no OS-level download mark that desktop environments act on.
 */
export async function markPluginSavedFileAsDownloaded(
  filePath: string,
  deps: DownloadMarkDeps = defaultDeps
): Promise<void> {
  try {
    if (deps.platform === 'win32') {
      // ZoneId=3 is the Internet zone: SmartScreen and Office Protected View apply.
      await deps.writeFile(`${filePath}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
    } else if (deps.platform === 'darwin') {
      const seconds = Math.floor(deps.now() / 1000).toString(16)
      await deps.runProcess({
        program: '/usr/bin/xattr',
        args: ['-w', 'com.apple.quarantine', `0083;${seconds};Orca;`, filePath],
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024
      })
    }
  } catch {
    // The file is saved either way; the mark only adds an OS warning.
  }
}
