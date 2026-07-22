import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PtyBindings, getPtyBindingsFile, type PtyBindingRecord } from './pty-bindings'

describe('PtyBindings', () => {
  let dir: string
  let dataFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-pty-bindings-'))
    dataFile = join(dir, 'orca-data.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const binding = (over: Partial<PtyBindingRecord> = {}): PtyBindingRecord => ({
    worktreeId: 'r1::/wt',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    ...over
  })

  it('records a binding synchronously and reloads it', () => {
    const store = new PtyBindings(dataFile)
    store.record(binding())
    // Sync write — the file exists immediately, no flush/await needed.
    const onDisk = JSON.parse(readFileSync(getPtyBindingsFile(dataFile), 'utf-8'))
    expect(onDisk.bindings).toHaveLength(1)

    const reloaded = new PtyBindings(dataFile)
    expect(reloaded.get()).toEqual([binding()])
  })

  it('supersedes an earlier ptyId for the same (tabId, leafId)', () => {
    const store = new PtyBindings(dataFile)
    store.record(binding({ ptyId: 'pty-old' }))
    store.record(binding({ ptyId: 'pty-new' }))
    expect(store.get()).toEqual([binding({ ptyId: 'pty-new' })])
  })

  it('keeps distinct leaves within a tab', () => {
    const store = new PtyBindings(dataFile)
    store.record(binding({ leafId: 'leaf-1', ptyId: 'pty-1' }))
    store.record(binding({ leafId: 'leaf-2', ptyId: 'pty-2' }))
    expect(store.get()).toHaveLength(2)
  })

  it('forgets a binding', () => {
    const store = new PtyBindings(dataFile)
    store.record(binding())
    store.forget('tab-1', 'leaf-1')
    expect(store.get()).toEqual([])
  })

  it('recovers from a corrupt sidecar file as empty', () => {
    const store = new PtyBindings(dataFile)
    store.record(binding())
    // Corrupt the file, then a fresh instance should not throw.
    writeFileSync(getPtyBindingsFile(dataFile), '{ not json', 'utf-8')
    const reloaded = new PtyBindings(dataFile)
    expect(reloaded.get()).toEqual([])
  })

  it('rejects malformed records on load', () => {
    writeFileSync(
      getPtyBindingsFile(dataFile),
      JSON.stringify({ bindings: [{ tabId: 'tab-1' }, binding()] }),
      'utf-8'
    )
    const store = new PtyBindings(dataFile)
    expect(store.get()).toEqual([binding()])
  })
})
