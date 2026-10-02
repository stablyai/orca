import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readKeybindingFile, writeKeybindingOverride } from './keybinding-file'
import { isJsonObject, type JsonObject } from './keybinding-file-parser'

function readDocument(filePath: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!isJsonObject(parsed)) {
    throw new Error('Expected the keybindings file to hold a JSON object.')
  }
  return parsed
}

function section(document: JsonObject, path: readonly string[]): JsonObject | undefined {
  let current: unknown = document
  for (const key of path) {
    if (!isJsonObject(current)) {
      return undefined
    }
    current = current[key]
  }
  return isJsonObject(current) ? current : undefined
}

/**
 * A build shipped before `MouseBack` existed ignores the unknown `mouse` root key
 * and preserves it verbatim through its own writes. Dropping the section is the
 * faithful stand-in for what such a build can see.
 */
function asDowngradedDocument(document: JsonObject): JsonObject {
  const next = { ...document }
  delete next.mouse
  return next
}

/**
 * The document assembly a build shipped before the mouse section used: it spreads
 * the document it read and replaces only version, keybindings, and platforms, so
 * a root key it does not know rides along untouched.
 */
function simulateDowngradedWrite(
  filePath: string,
  actionId: string,
  bindings: readonly string[]
): void {
  const document = readDocument(filePath)
  const platforms = section(document, ['platforms']) ?? {}
  const darwin = section(document, ['platforms', 'darwin']) ?? {}
  writeFileSync(
    filePath,
    JSON.stringify({
      ...document,
      version: 1,
      keybindings: section(document, ['keybindings']) ?? {},
      platforms: { ...platforms, darwin: { ...darwin, [actionId]: bindings } }
    })
  )
}

describe('keybinding-file mouse section', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-keybindings-mouse-'))
    filePath = join(dir, 'keybindings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores a mouse binding apart from the action keyboard chords and rejoins them on read', () => {
    const snapshot = writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', [
      'Mod+Shift+P',
      'Shift+MouseBack'
    ])

    expect(snapshot.overrides['worktree.palette']).toEqual(['Mod+Shift+P', 'Shift+MouseBack'])
    expect(section(readDocument(filePath), ['platforms', 'darwin'])).toEqual({
      'worktree.palette': ['Mod+Shift+P']
    })
    expect(section(readDocument(filePath), ['mouse', 'platforms', 'darwin'])).toEqual({
      'worktree.palette': ['Shift+MouseBack']
    })
  })

  it('leaves the keyboard chords readable by a build that cannot parse the mouse token', () => {
    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['Mod+Shift+P', 'MouseBack'])

    writeFileSync(filePath, JSON.stringify(asDowngradedDocument(readDocument(filePath))))

    expect(readKeybindingFile(filePath, 'darwin').overrides['worktree.palette']).toEqual([
      'Mod+Shift+P'
    ])
  })

  it('records a mouse-only binding as an empty keyboard list so a downgrade reads it as unbound', () => {
    const snapshot = writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['MouseBack'])

    expect(snapshot.overrides['worktree.palette']).toEqual(['MouseBack'])
    expect(section(readDocument(filePath), ['platforms', 'darwin'])).toEqual({
      'worktree.palette': []
    })

    writeFileSync(filePath, JSON.stringify(asDowngradedDocument(readDocument(filePath))))
    expect(readKeybindingFile(filePath, 'darwin').overrides['worktree.palette']).toEqual([])
  })

  it('omits the mouse section until a mouse binding exists and prunes it on reset', () => {
    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['Mod+Shift+P'])
    expect(readDocument(filePath).mouse).toBeUndefined()

    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['Mod+Shift+P', 'MouseBack'])
    expect(readDocument(filePath).mouse).toBeDefined()

    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['Mod+Shift+P'])
    expect(readDocument(filePath).mouse).toBeUndefined()
  })

  it('clears both sections when an action is reset', () => {
    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['Mod+Shift+P', 'MouseBack'])

    const snapshot = writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', null)

    expect(snapshot.overrides['worktree.palette']).toBeUndefined()
    expect(readDocument(filePath).mouse).toBeUndefined()
  })

  it('keeps another action mouse binding when an unrelated action is edited', () => {
    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['MouseBack'])

    const snapshot = writeKeybindingOverride(filePath, 'darwin', 'worktree.quickOpen', [
      'Mod+Shift+O'
    ])

    expect(snapshot.overrides['worktree.palette']).toEqual(['MouseBack'])
    expect(snapshot.overrides['worktree.quickOpen']).toEqual(['Mod+Shift+O'])
  })

  it('survives a write by a build that does not know the section', () => {
    writeKeybindingOverride(filePath, 'darwin', 'worktree.palette', ['Mod+Shift+P', 'MouseBack'])

    simulateDowngradedWrite(filePath, 'worktree.quickOpen', ['Mod+Shift+O'])

    const snapshot = readKeybindingFile(filePath, 'darwin')
    expect(snapshot.overrides['worktree.palette']).toEqual(['Mod+Shift+P', 'MouseBack'])
    expect(snapshot.overrides['worktree.quickOpen']).toEqual(['Mod+Shift+O'])
  })

  it('reads a hand-authored mouse section, including its common layer', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        keybindings: { 'worktree.palette': ['Mod+Shift+P'] },
        platforms: { darwin: {}, linux: {}, win32: {} },
        mouse: {
          keybindings: { 'worktree.palette': ['MouseForward'] },
          platforms: { darwin: { 'worktree.quickOpen': 'MouseBack' } }
        }
      })
    )

    const snapshot = readKeybindingFile(filePath, 'darwin')

    expect(snapshot.overrides['worktree.palette']).toEqual(['Mod+Shift+P', 'MouseForward'])
    expect(snapshot.overrides['worktree.quickOpen']).toEqual(['MouseBack'])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('reports a mouse section that is not an object', () => {
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, keybindings: {}, platforms: {}, mouse: 'MouseBack' })
    )

    expect(readKeybindingFile(filePath, 'darwin').diagnostics).toEqual([
      {
        severity: 'error',
        section: 'mouse',
        message: 'mouse must be an object with keybindings or platforms sections.'
      }
    ])
  })
})

describe('keybinding-file per-binding tolerance', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-keybindings-tolerance-'))
    filePath = join(dir, 'keybindings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the bindings it understands and reports only the entry it dropped', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        keybindings: { 'worktree.palette': ['Mod+Shift+P', 'Mod+NotAKey'] }
      })
    )

    const snapshot = readKeybindingFile(filePath, 'darwin')

    expect(snapshot.overrides['worktree.palette']).toEqual(['Mod+Shift+P'])
    expect(snapshot.diagnostics).toEqual([
      {
        severity: 'error',
        section: 'keybindings',
        actionId: 'worktree.palette',
        message:
          'Shortcut "Mod+NotAKey" for "worktree.palette" was ignored: Use a shortcut like Ctrl+Shift+P or Cmd+K.'
      }
    ])
  })

  it('falls back to the action defaults when no binding survived', () => {
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, keybindings: { 'worktree.palette': ['Mod+NotAKey'] } })
    )

    const snapshot = readKeybindingFile(filePath, 'darwin')

    expect(snapshot.overrides['worktree.palette']).toBeUndefined()
    expect(snapshot.diagnostics).toHaveLength(1)
  })
})
