import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pinRuntimeBuildIdentity,
  resetPinnedRuntimeBuildIdentityForTest
} from './runtime-build-identity'

/** The contradiction this closes: build identity was re-resolved on every read,
 *  and the checkout read is part of it. A certification run that moved the tree
 *  — its own commits included — changed what the runtime claimed to BE halfway
 *  through, so evidence recorded at the start no longer matched the runtime that
 *  recorded it. */
describe('one build identity per process', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-pin-'))
  afterEach(() => resetPinnedRuntimeBuildIdentityForTest())

  function entry(name: string, contents: string): string {
    const path = join(root, name)
    writeFileSync(path, contents)
    return path
  }

  it('build A stays A after the entry file it was measured from changes', () => {
    const path = entry('entry-a.js', 'console.log("a")')
    const pinned = pinRuntimeBuildIdentity(path)
    writeFileSync(path, 'console.log("a-modified-under-the-running-process")')
    expect(pinRuntimeBuildIdentity()).toEqual(pinned)
    expect(pinRuntimeBuildIdentity().id).toBe(pinned.id)
  })

  it('ignores a later pin request naming a different entry', () => {
    const pinned = pinRuntimeBuildIdentity(entry('entry-a2.js', 'a'))
    expect(pinRuntimeBuildIdentity(entry('entry-b2.js', 'b')).id).toBe(pinned.id)
  })

  it('is frozen, so no consumer can mutate the shared object', () => {
    const pinned = pinRuntimeBuildIdentity(entry('entry-frozen.js', 'x'))
    expect(Object.isFrozen(pinned)).toBe(true)
  })

  it('a restarted process is build B, and B does not answer to A', () => {
    const a = pinRuntimeBuildIdentity(entry('entry-a3.js', 'console.log("a")'))
    resetPinnedRuntimeBuildIdentityForTest()
    const b = pinRuntimeBuildIdentity(entry('entry-b3.js', 'console.log("b-is-different")'))
    expect(b.id).not.toBe(a.id)
    expect(b.buildHash).not.toBe(a.buildHash)
    // Evidence is stamped with `id`, so A's evidence cannot read as current on B.
    const evidenceFromA = { runtimeVersion: a.id }
    expect(evidenceFromA.runtimeVersion === b.id).toBe(false)
  })
})
