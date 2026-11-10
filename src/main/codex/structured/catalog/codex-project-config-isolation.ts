import { realpath } from 'node:fs/promises'

/** `-c` arguments that keep Codex from loading `dir`'s project config, so a listing that must run
 *  there still reports only the account's catalog. Needs `project_root_markers=[]` so no folder
 *  above `dir` is read. Override keys split on dots, so the folders go in the value. A managed
 *  config that trusts the folder still wins. */
export async function codexProjectConfigIsolationArgs(dir: string): Promise<string[]> {
  const real = await realpath(dir).catch(() => dir)
  const table = [...new Set([dir, real])]
    .map((folder) => `${JSON.stringify(folder)}={trust_level="untrusted"}`)
    .join(',')
  return ['-c', `projects={${table}}`]
}
