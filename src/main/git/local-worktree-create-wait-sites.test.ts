import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why a ratchet: waiting for creates to settle is only safe at a background producer's entry.
// Inside a request/response path (a renderer IPC handler, a runtime RPC, a paired client, the
// CLI) it would park a caller for up to the deadline. A new call site must be a producer that
// nothing awaits; request paths answer from cache instead.

// Each waiter (the primitives, and the exports that await them) with the only files that may call it.
const WAITERS: Record<string, { definedIn: string; callers: string[] }> = {
  whenLocalWorktreeCreatesSettle: {
    definedIn: 'src/main/git/local-worktree-create-activity.ts',
    callers: [
      'src/main/ipc/worktree-base-directory-notifications.ts',
      'src/main/worktree-trash.ts',
      'src/main/retired-worktree-create-preparation-sweep.ts',
      'src/main/worktree-create-spare-discard.ts'
    ]
  },
  createLocalWorktreeCreateDeferral: {
    definedIn: 'src/main/git/local-worktree-create-activity.ts',
    callers: ['src/main/github/pr-refresh-queue-drainer.ts']
  },
  sweepStaleWorktreeTrash: {
    definedIn: 'src/main/worktree-trash.ts',
    callers: ['src/main/startup/main-process-ready-runtime.ts']
  },
  _whenSpareDiscardsSettledForTests: {
    definedIn: 'src/main/worktree-create-spare-discard.ts',
    callers: []
  },
  sweepRetiredWorktreeCreatePreparations: {
    definedIn: 'src/main/retired-worktree-create-preparation-sweep.ts',
    callers: ['src/main/startup/main-process-ready-runtime.ts']
  }
}

// Promise-returning exports of the waiting modules that do not wait for creates to settle.
const NON_WAITING_ASYNC_EXPORTS = new Set(['runWithLocalWorktreeCreateHold'])

const REPO_ROOT = join(__dirname, '..', '..', '..')

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function readSources(): Map<string, string> {
  const sources = new Map<string, string>()
  for (const file of ['src/main', 'src/shared', 'src/relay'].flatMap((dir) =>
    sourceFiles(join(REPO_ROOT, dir))
  )) {
    sources.set(relative(REPO_ROOT, file).split(sep).join('/'), readFileSync(file, 'utf8'))
  }
  return sources
}

function mentions(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source)
}

/** Exported functions whose signature (up to the body's opening brace) returns a promise. */
function promiseReturningExports(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/^export (async )?function (\w+)/gm)) {
    const rest = source.slice(match.index)
    const signatureEnd = /\)(:[^\n]*)?\s*\{\s*$/m.exec(rest)
    const signature = rest.slice(0, signatureEnd ? signatureEnd.index + signatureEnd[0].length : 0)
    if (match[1] || signature.includes('Promise<')) {
      names.push(match[2])
    }
  }
  return names
}

describe('local worktree create wait sites', () => {
  const sources = readSources()

  it('only background producers call a waiter', () => {
    const unexpected: string[] = []
    for (const [name, { definedIn, callers }] of Object.entries(WAITERS)) {
      for (const [file, source] of sources) {
        if (file !== definedIn && !callers.includes(file) && mentions(source, name)) {
          unexpected.push(`${file} -> ${name}`)
        }
      }
    }
    expect(unexpected).toEqual([])
  })

  it('keeps the waiter list honest', () => {
    const stale: string[] = []
    for (const [name, { definedIn, callers }] of Object.entries(WAITERS)) {
      if (
        !new RegExp(`^export (async )?function ${name}\\b`, 'm').test(sources.get(definedIn) ?? '')
      ) {
        stale.push(`${definedIn} no longer exports ${name}`)
      }
      for (const caller of callers) {
        if (!mentions(sources.get(caller) ?? '', name)) {
          stale.push(`${caller} no longer calls ${name}`)
        }
      }
    }
    expect(stale).toEqual([])
  })

  it('classifies every promise-returning export of a waiting module', () => {
    // A new async export of a module that waits may wait too; it must join WAITERS or be declared
    // non-waiting, so a transitive waiter cannot slip into a request path unseen.
    const definingModules = new Set(Object.values(WAITERS).map(({ definedIn }) => definedIn))
    const unclassified: string[] = []
    for (const [file, source] of sources) {
      if (!definingModules.has(file) && !mentions(source, 'whenLocalWorktreeCreatesSettle')) {
        continue
      }
      for (const name of promiseReturningExports(source)) {
        if (!(name in WAITERS) && !NON_WAITING_ASYNC_EXPORTS.has(name)) {
          unclassified.push(`${file}: ${name}`)
        }
      }
    }
    expect(unclassified).toEqual([])
  })
})
