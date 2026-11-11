import { runProcess } from '@orca/process-host'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'

/** What this host last wrote for one syncing computer: item key -> digest. Never contents. */
export type Ledger = { version: 1; items: Record<string, string> }

export function ledgerPath(ledgerDir: string, syncer: string): string {
  return join(ledgerDir, `agent-config-sync-ledger-${syncer}.json`)
}

export async function readLedger(path: string): Promise<Ledger> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const items =
      parsed && typeof parsed === 'object' && 'items' in parsed ? parsed.items : undefined
    const clean: Record<string, string> = {}
    if (items && typeof items === 'object') {
      for (const [key, value] of Object.entries(items)) {
        if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) {
          clean[key] = value
        }
      }
    }
    return { version: 1, items: clean }
  } catch {
    return { version: 1, items: {} }
  }
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  writeFileAtomically(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
}

/** Keeps a synced project item out of the sandbox's git status (local exclude, never committed). */
export async function excludeFromGit(
  projectPath: string,
  dest: string,
  isDir: boolean
): Promise<void> {
  try {
    const { code, stdout } = await runProcess({
      program: 'git',
      args: [
        '-C',
        projectPath,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'info/exclude'
      ],
      timeoutMs: 5_000
    })
    if (code !== 0) {
      return
    }
    const excludePath = stdout.trim()
    if (!excludePath) {
      return
    }
    const rel = dest.slice(projectPath.length).split('\\').join('/')
    const line = `${rel.startsWith('/') ? rel : `/${rel}`}${isDir ? '/' : ''}`
    const current = await readFile(excludePath, 'utf8').catch(() => '')
    if (current.split('\n').includes(line)) {
      return
    }
    await mkdir(dirname(excludePath), { recursive: true })
    await appendFile(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`)
  } catch {
    // Not a git checkout here; the item still works, it just shows as untracked.
  }
}
