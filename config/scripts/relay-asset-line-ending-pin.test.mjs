import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { RELAY_ARTIFACTS } from '../../src/shared/relay-artifacts.ts'
import { describe, expect, it } from 'vitest'

/**
 * Guard the `.gitattributes` pin that keeps `config/relay-assets` on LF.
 *
 * `core.autocrlf=true` ships in the Git-for-Windows system config, so without a
 * pin a Windows runner checks these out as CRLF. build-relay.mjs copies them
 * verbatim into the bundle and hashes them byte-for-byte into `.version`, which
 * names the immutable remote relay directory -- so a Windows-built client and a
 * mac/Linux-built one disagree on the same release, and one SSH host ends up with
 * two relay trees, each paying its own remote native-dep compile.
 *
 * Measured on v1.4.197: master-cloexec-patch.cjs shipped at 11229 bytes from the
 * mac runner and 11547 (= 11229 + 318 lines) from the Windows one.
 */
const projectDir = resolve(import.meta.dirname, '../..')

function git(args) {
  return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' })
}

/** `git check-attr -z` emits NUL-separated path/attr/value triples. */
function eolAttributes(paths) {
  const fields = git(['check-attr', '-z', 'eol', '--', ...paths]).split('\0')
  const found = new Map()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    found.set(fields[index], fields[index + 2])
  }
  return found
}

/**
 * Keyed off the manifest, not a directory: build-relay refuses to emit an
 * artifact absent from RELAY_ARTIFACTS, so relocating an asset cannot slip
 * past this the way a path glob would. esbuild bundles have no tracked
 * source and contribute no hits, so they need no classifying.
 */
function trackedManifestSources() {
  const paths = new Set()
  for (const { filename } of RELAY_ARTIFACTS) {
    const hits = git(['ls-files', '-z', '--', `*/${filename}`])
      .split('\0')
      .filter(Boolean)
    for (const path of hits) {
      paths.add(path)
    }
  }
  return [...paths]
}

describe('config/relay-assets line-ending pin', () => {
  it('pins every tracked relay artifact source to LF', () => {
    const assets = trackedManifestSources()
    expect(assets.length).toBeGreaterThan(0)

    const attributes = eolAttributes(assets)
    const unpinned = assets.filter((path) => attributes.get(path) !== 'lf')

    expect(
      unpinned,
      'A relay asset left on the platform default gets CRLF on a Windows runner, ' +
        'which changes the .version hash and splits one release across two remote ' +
        'relay directories. Pin it in .gitattributes.'
    ).toEqual([])
  })

  // Why: the assertion above only sees files that exist today. These fix the
  // pattern itself -- broad enough to cover a file added tomorrow, narrow enough
  // not to claim neighbours.
  it.each([
    ['config/relay-assets/example.cjs', 'lf'],
    ['config/relay-assets/nested/deeper/example.cjs', 'lf'],
    ['config/relay-assets/example.txt', 'lf'],
    ['config/relay-assets-extra/example.cjs', 'unspecified'],
    ['vendor/config/relay-assets/example.cjs', 'unspecified']
  ])('resolves %s to eol=%s', (path, expected) => {
    expect(eolAttributes([path]).get(path)).toBe(expected)
  })
})
