// Which tap a Homebrew-installed CLI came from: a Cellar path alone can't say, since taps may reuse a formula name.

import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const receiptSchema = z.object({ source: z.object({ tap: z.string() }) })

/** The tap named by the install receipt beside the keg's version folder, or null when unreadable. */
export async function homebrewInstallTap(realPath: string): Promise<string | null> {
  const version = /^(.*\/Cellar\/[^/]+\/[^/]+)\//.exec(realPath.replaceAll('\\', '/'))
  if (!version) {
    return null
  }
  try {
    const receipt = JSON.parse(await readFile(`${version[1]}/INSTALL_RECEIPT.json`, 'utf8'))
    return receiptSchema.parse(receipt).source.tap
  } catch {
    return null
  }
}
