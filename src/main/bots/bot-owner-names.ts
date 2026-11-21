// The owner's names as this computer knows them, so a memory line that says "Dana picked" reads as
// the owner deciding. From the account's full name (macOS) and git's user.name, every word of each;
// none when neither is set, and then only the word "owner" counts.
import { runProcess } from '@orca/process-host'

let names: Promise<string[]> | null = null

async function output(program: string, args: string[]): Promise<string | null> {
  try {
    const { code, stdout } = await runProcess({ program, args, timeoutMs: 5_000 })
    return code === 0 && stdout.trim() ? stdout.trim() : null
  } catch {
    return null
  }
}

/** Read once per process. Logs which sources gave names, never the names. */
export function hostOwnerNames(): Promise<string[]> {
  names ??= (async () => {
    const sources = {
      account: process.platform === 'darwin' ? await output('/usr/bin/id', ['-F']) : null,
      git: await output('git', ['config', '--global', 'user.name'])
    }
    const words = Object.values(sources)
      .flatMap((full) => full?.split(/\s+/) ?? [])
      .filter((word) => /^\p{L}[\p{L}'-]+$/u.test(word) && word.toLowerCase() !== 'owner')
    const found = Object.entries(sources).flatMap(([source, full]) => (full ? [source] : []))
    console.info(`[bots] owner names for memory from: ${found.join(', ') || 'none'}`)
    return [...new Set(words)]
  })()
  return names
}
