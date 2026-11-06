import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** `-c` arguments that keep Codex from loading project config in `dir` or any folder above it, so
 *  a listing that must run there still reports only the account's catalog. Codex applies overrides
 *  before deciding trust, and splits override keys on dots, so the folders go in the value. A
 *  managed config that trusts the folder still wins. */
export async function codexProjectConfigIsolationArgs(dir: string): Promise<string[]> {
  const real = await realpath(dir).catch(() => dir)
  const folders = new Set([...ancestors(dir), ...ancestors(real)])
  const table = [...folders]
    .map((folder) => `${JSON.stringify(folder)}={trust_level="untrusted"}`)
    .join(',')
  return ['-c', `projects={${table}}`]
}

function ancestors(dir: string): string[] {
  const path = dir.startsWith('/') ? posix : win32
  const chain: string[] = []
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    chain.push(at)
    if (path.dirname(at) === at) {
      return chain
    }
  }
}
