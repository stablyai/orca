import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Why: every Orca build on a machine (stable, RC, dev) shares ~/.orca/agent-hooks, so an older
// build's refresh would replace a newer build's script. A per-directory ledger records which
// generation wrote each script; bytes it does not know came from a pre-ledger build (generation 0).
// Bump on any change to a managed script's bytes; managed-hook-script-refresh.test.ts pins it.
export const MANAGED_SCRIPT_GENERATION = 1

export const MANAGED_SCRIPT_LEDGER_FILE = '.orca-managed-scripts.json'

type LedgerEntry = { generation: number; sha256: string }
type Ledger = Record<string, LedgerEntry>

function ledgerPath(scriptPath: string): string {
  return join(dirname(scriptPath), MANAGED_SCRIPT_LEDGER_FILE)
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function parseLedger(text: string | null): Ledger {
  if (text === null) {
    return {}
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {}
    }
    const ledger: Ledger = {}
    for (const [name, entry] of Object.entries(value)) {
      const generation: unknown = Reflect.get(Object(entry), 'generation')
      const digest: unknown = Reflect.get(Object(entry), 'sha256')
      if (
        typeof generation === 'number' &&
        Number.isInteger(generation) &&
        typeof digest === 'string'
      ) {
        ledger[name] = { generation, sha256: digest }
      }
    }
    return ledger
  } catch {
    // Why: a torn or hand-edited ledger only costs the guard, never a script write.
    return {}
  }
}

function writerGeneration(ledger: Ledger, scriptPath: string, content: string): number {
  const entry = ledger[basename(scriptPath)]
  return entry && entry.sha256 === sha256(content) ? entry.generation : 0
}

/** Ledger after this build wrote (or found) `content`; null when it is already right. */
function nextLedger(
  ledger: Ledger,
  scriptPath: string,
  content: string,
  generation: number
): Ledger | null {
  const name = basename(scriptPath)
  const digest = sha256(content)
  const entry = ledger[name]
  // Why keep a higher generation: identical bytes from a newer build stay attributed to it.
  if (entry && entry.sha256 === digest && entry.generation >= generation) {
    return null
  }
  return { ...ledger, [name]: { generation, sha256: digest } }
}

function serialize(ledger: Ledger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

function tmpLedgerPath(scriptPath: string): string {
  return join(dirname(scriptPath), `.${Date.now()}-${randomUUID()}.ledger.tmp`)
}

function readTextSync(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** True when `existing` (the script's current bytes) came from a newer build than this one. */
export function isNewerManagedScriptSync(
  scriptPath: string,
  existing: string,
  generation = MANAGED_SCRIPT_GENERATION
): boolean {
  return (
    writerGeneration(parseLedger(readTextSync(ledgerPath(scriptPath))), scriptPath, existing) >
    generation
  )
}

export async function isNewerManagedScript(
  scriptPath: string,
  existing: string,
  generation = MANAGED_SCRIPT_GENERATION
): Promise<boolean> {
  return (
    writerGeneration(parseLedger(await readText(ledgerPath(scriptPath))), scriptPath, existing) >
    generation
  )
}

// Why best effort: the ledger only steers later writers; a failed update must not fail the install.
export function recordManagedScriptSync(
  scriptPath: string,
  content: string,
  generation = MANAGED_SCRIPT_GENERATION
): void {
  const path = ledgerPath(scriptPath)
  const next = nextLedger(parseLedger(readTextSync(path)), scriptPath, content, generation)
  if (!next) {
    return
  }
  const tmp = tmpLedgerPath(scriptPath)
  try {
    writeFileSync(tmp, serialize(next), 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    console.warn('[agent-hooks] could not record managed script generation:', error)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export async function recordManagedScript(
  scriptPath: string,
  content: string,
  generation = MANAGED_SCRIPT_GENERATION
): Promise<void> {
  const path = ledgerPath(scriptPath)
  const next = nextLedger(parseLedger(await readText(path)), scriptPath, content, generation)
  if (!next) {
    return
  }
  const tmp = tmpLedgerPath(scriptPath)
  try {
    await writeFile(tmp, serialize(next), 'utf-8')
    await rename(tmp, path)
  } catch (error) {
    console.warn('[agent-hooks] could not record managed script generation:', error)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}
