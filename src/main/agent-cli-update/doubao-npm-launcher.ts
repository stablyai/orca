import { realpath } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { parseWindowsCmdShim } from '@orca/process-host/windows-cmd-shim-resolution'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'

const NPM_ENTRY = 'node_modules/@bytedance/doubao-cli/scripts/run.cjs'

/** Only the public npm launcher implements `doubao update`; the native CLI handles other commands. */
export async function isDoubaoNpmLauncher(
  program: string,
  realPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform !== 'win32') {
    return realPath.endsWith(`/lib/${NPM_ENTRY}`)
  }
  if (win32.basename(program).toLowerCase() !== 'doubao.cmd') {
    return false
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(program, 64 * 1024, { regularFileOnly: true })
    const shim = parseWindowsCmdShim(buffer.toString('utf8'))
    if (shim?.kind !== 'node' || shim.script.replaceAll('\\', '/').toLowerCase() !== NPM_ENTRY) {
      return false
    }
    const realEntry = await realpath(join(dirname(program), NPM_ENTRY))
    return realEntry.toLowerCase() === join(dirname(realPath), NPM_ENTRY).toLowerCase()
  } catch {
    return false
  }
}
