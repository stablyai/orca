const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { applyPatch, parsePatch, reversePatch } = require('diff')
const root = path.resolve(__dirname, '../../..')
const canonicalLf = (text) => text.replaceAll('\r\n', '\n')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const readText = (filename) => canonicalLf(readFileSync(filename, 'utf8'))
const versions = JSON.parse(readText(path.join(__dirname, 'source-versions.json')))

function patchMap(filename, read) {
  return new Map(
    parsePatch(canonicalLf(read(path.join(__dirname, filename)))).map((patch) => {
      assert.ok(patch.oldFileName.startsWith('a/'))
      assert.ok(patch.newFileName.startsWith('b/'))
      assert.equal(patch.oldFileName.slice(2), patch.newFileName.slice(2))
      return [patch.newFileName.slice(2), patch]
    })
  )
}

function apply(source, patch, reverse = false) {
  const result = applyPatch(source ?? '', reverse ? reversePatch(patch) : patch)
  assert.notEqual(result, false, 'Source patch no longer applies')
  return result
}

function loadSources({
  graph = process.env.ORCA_CLOSED_MODEL_GRAPH ?? 'worktree',
  variant = process.env.ORCA_CLOSED_MODEL_VARIANT ?? 'fixed',
  read = readText,
  exists = existsSync
} = {}) {
  assert.ok(graph === 'worktree' || graph === 'main')
  assert.ok(variant === 'before' || variant === 'fixed')
  const fixes = patchMap('fix.patch', read)
  const contexts = patchMap('main-context.patch', read)
  for (const [relative, expected] of Object.entries(versions.dependencies)) {
    assert.equal(
      sha256(canonicalLf(read(path.join(root, relative)))),
      expected,
      `Dependency drift: ${relative}`
    )
  }
  const sources = new Map()
  const hashes = {}
  for (const [relative, expected] of Object.entries(versions.sources)) {
    const filename = path.join(root, relative)
    let source = exists(filename) ? canonicalLf(read(filename)) : null
    const actual = source === null ? null : sha256(source)
    const fix = fixes.get(relative)
    const context = contexts.get(relative)
    if (fix && source !== null) {
      assert.ok(
        actual === expected.worktreeFixed || actual === expected.mainFixed,
        `Fixed source drift: ${relative}`
      )
      source = apply(source, fix, true)
      if (expected.worktreeBefore === null && expected.mainBefore === null) {
        assert.equal(source, '')
        source = null
      }
    }
    let baselineHash = source === null ? null : sha256(source)
    assert.ok(
      baselineHash === expected.worktreeBefore || baselineHash === expected.mainBefore,
      `Source graph drift: ${relative}`
    )
    const desired = expected[`${graph}Before`]
    if (baselineHash !== desired) {
      assert.ok(context, `Missing graph context: ${relative}`)
      source = apply(source, context, graph === 'worktree')
      if (desired === null) {
        assert.equal(source, '')
        source = null
      }
      baselineHash = source === null ? null : sha256(source)
    }
    assert.equal(baselineHash, desired, `Named graph drift: ${relative}`)
    if (variant === 'fixed' && fix) {
      source = apply(source, fix)
      assert.equal(sha256(source), expected[`${graph}Fixed`], `Fixed graph drift: ${relative}`)
    }
    if (source !== null) {
      sources.set(filename, source)
      hashes[relative] = sha256(source)
    }
  }
  return { root, graph, variant, sources, hashes }
}

module.exports = { loadSources, canonicalLf, readText, sha256, versions }
