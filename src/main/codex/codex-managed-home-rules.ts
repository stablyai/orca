import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  recoverInterruptedGuardedFileOperation,
  removeFileAtomicallyIfUnchanged,
  writeFileAtomicallyIfUnchanged
} from '../codex-accounts/fs-utils'
import { observe } from './codex-path-observation'

const IMPORT_PREFIX = 'orca-global-'
const MANIFEST_NAME = '.orca-global-rule-imports.json'
type RuleChange = { sourceName: string; before: string | null; after: string | null }
type RuleManifest = { sourcePath: string; files: Record<string, RuleChange> }

function fail(): never {
  throw new Error(
    'Cannot safely import global Codex rules; launch stopped. Check rule-file permissions and conflicting Orca import files in the managed Codex home, then retry without deleting account rules.'
  )
}

function readRegularFile(path: string): string | null {
  const entry = observe(() => lstatSync(path))
  if (entry.kind === 'absent') {
    return null
  }
  if (entry.kind !== 'present' || !entry.value.isFile()) {
    fail()
  }
  return readFileSync(path, 'utf8')
}

function ensureOwnedDirectory(path: string): void {
  const entry = observe(() => lstatSync(path))
  if (entry.kind === 'absent') {
    mkdirSync(path)
  } else if (
    entry.kind !== 'present' ||
    !entry.value.isDirectory() ||
    entry.value.isSymbolicLink()
  ) {
    fail()
  }
}

function ruleNames(path: string): string[] {
  const directory = observe(() => statSync(path))
  if (directory.kind === 'absent') {
    return []
  }
  if (directory.kind !== 'present' || !directory.value.isDirectory()) {
    fail()
  }
  const entry = observe(() => readdirSync(path))
  if (entry.kind === 'absent') {
    return []
  }
  if (entry.kind !== 'present') {
    fail()
  }
  return entry.value
    .filter((name) => name.endsWith('.rules') && lstatSync(join(path, name)).isFile())
    .sort()
}

function snapshotRules(path: string): Record<string, { sourceName: string; contents: string }> {
  const names = ruleNames(path)
  const files: Record<string, { sourceName: string; contents: string }> = {}
  for (const [index, name] of names.entries()) {
    const source = join(path, name)
    if (!lstatSync(source).isFile()) {
      fail()
    }
    files[importName(name, index)] = { sourceName: name, contents: readFileSync(source, 'utf8') }
  }
  // A changing source is not a coherent permission-policy snapshot.
  if (JSON.stringify(ruleNames(path)) !== JSON.stringify(names)) {
    fail()
  }
  for (const [index, name] of names.entries()) {
    if (readFileSync(join(path, name), 'utf8') !== files[importName(name, index)].contents) {
      fail()
    }
  }
  return files
}

function importName(sourceName: string, index: number): string {
  const digest = createHash('sha256').update(sourceName).digest('hex').slice(0, 32)
  return `${IMPORT_PREFIX}${String(index).padStart(10, '0')}-${digest}.rules`
}

function recoverRegularFile(path: string, validate: (contents: string) => void): void {
  const held = readRegularFile(`${path}.orca-guarded`)
  if (held === null) {
    return
  }
  validate(held)
  const current = readRegularFile(path)
  if (current !== null) {
    validate(current)
  }
  recoverInterruptedGuardedFileOperation(path)
}

function parseManifest(contents: string | null, sourcePath: string): RuleManifest {
  if (contents === null) {
    return { sourcePath, files: {} }
  }
  const value: unknown = JSON.parse(contents)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail()
  }
  if (!('sourcePath' in value) || value.sourcePath !== sourcePath || !('files' in value)) {
    fail()
  }
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    fail()
  }
  const files: Record<string, RuleChange> = {}
  for (const [name, change] of Object.entries(value.files)) {
    if (!name.startsWith(IMPORT_PREFIX) || !name.endsWith('.rules') || /[/\\]/.test(name)) {
      fail()
    }
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      fail()
    }
    if (!('before' in change) || !('after' in change) || !('sourceName' in change)) {
      fail()
    }
    if (typeof change.sourceName !== 'string' || !change.sourceName.endsWith('.rules')) {
      fail()
    }
    if (change.before !== null && typeof change.before !== 'string') {
      fail()
    }
    if (change.after !== null && typeof change.after !== 'string') {
      fail()
    }
    files[name] = { sourceName: change.sourceName, before: change.before, after: change.after }
  }
  return { sourcePath, files }
}

function publishManifest(path: string, previous: string | null, manifest: RuleManifest): string {
  const contents = `${JSON.stringify(manifest)}\n`
  if (
    previous !== contents &&
    !writeFileAtomicallyIfUnchanged(path, previous, contents, { mode: 0o600 })
  ) {
    fail()
  }
  return contents
}

function applyChanges(rulesPath: string, manifest: RuleManifest): RuleManifest {
  const settled: RuleManifest = { sourcePath: manifest.sourcePath, files: {} }
  for (const [name, change] of Object.entries(manifest.files)) {
    const path = join(rulesPath, name)
    recoverRegularFile(path, (contents) => {
      if (contents !== change.before && contents !== change.after) {
        fail()
      }
    })
    const current = readRegularFile(path)
    if (current !== change.after) {
      if (current !== change.before) {
        fail()
      }
      if (change.after === null) {
        if (current !== null && !removeFileAtomicallyIfUnchanged(path, current)) {
          fail()
        }
      } else if (!writeFileAtomicallyIfUnchanged(path, current, change.after, { mode: 0o600 })) {
        fail()
      }
    }
    if (change.after !== null) {
      settled.files[name] = {
        sourceName: change.sourceName,
        before: change.after,
        after: change.after
      }
    }
  }
  return settled
}

/** Global reads are imported; Codex's writable default.rules stays account-local. */
export function syncSystemCodexRules(systemHomePath: string, managedHomePath: string): void {
  const sourcePath = join(systemHomePath, 'rules')
  const desired = snapshotRules(sourcePath)
  const manifestPath = join(managedHomePath, MANIFEST_NAME)
  recoverRegularFile(manifestPath, (contents) => {
    parseManifest(contents, sourcePath)
  })
  let previous = readRegularFile(manifestPath)
  const existing = parseManifest(previous, sourcePath)
  if (Object.keys(desired).length === 0 && Object.keys(existing.files).length === 0) {
    return
  }
  const rulesPath = join(managedHomePath, 'rules')
  ensureOwnedDirectory(rulesPath)
  // A persisted pending change makes interrupted publication recoverable without claiming user files.
  const settled = applyChanges(rulesPath, existing)
  previous = publishManifest(manifestPath, previous, settled)
  const pending: RuleManifest = { sourcePath, files: {} }
  for (const name of new Set([...Object.keys(settled.files), ...Object.keys(desired)])) {
    const before = settled.files[name]?.after ?? null
    if (readRegularFile(join(rulesPath, name)) !== before) {
      fail()
    }
    pending.files[name] = {
      sourceName: desired[name]?.sourceName ?? settled.files[name].sourceName,
      before,
      after: desired[name]?.contents ?? null
    }
  }
  previous = publishManifest(manifestPath, previous, pending)
  publishManifest(manifestPath, previous, applyChanges(rulesPath, pending))
}
