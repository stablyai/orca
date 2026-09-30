const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { applyPatch, parsePatch, reversePatch } = require('diff')
const root = path.resolve(__dirname, '../../..')
const canonicalLf = (text) => text.replaceAll('\r\n', '\n')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const readText = (filename) => canonicalLf(readFileSync(filename, 'utf8'))
const versions = JSON.parse(readText(path.join(__dirname, 'source-versions.json')))

function checkedPatch(name, expectedPath, read) {
  const patches = parsePatch(canonicalLf(read(path.join(__dirname, name))))
  assert.equal(patches.length, 1)
  assert.equal(patches[0].newFileName, `b/${expectedPath}`)
  assert.equal(patches[0].oldFileName, `a/${expectedPath}`)
  return patches[0]
}

function observePending(source) {
  return source.replace(
    '    const pending: PendingFrame[] = []',
    '    const pending: PendingFrame[] = []; globalThis.__sshPendingReaders.set(filePath, new WeakRef(pending))'
  )
}

function loadSources({
  graph = process.env.ORCA_SSH_READER_GRAPH ?? 'worktree',
  variant = process.env.ORCA_SSH_READER_VARIANT ?? 'fixed',
  read = readText
} = {}) {
  assert.ok(graph === 'worktree' || graph === 'main')
  assert.ok(variant === 'before' || variant === 'fixed')
  const targetPatch = checkedPatch('fix.patch', versions.sourcePath, read)
  const contextPatch = checkedPatch('main-context.patch', versions.contextPath, read)
  const sources = new Map()
  const hashes = {}
  const selected = graph === 'main' ? versions.mainGraph : versions.worktreeGraph
  for (const [relative, expected] of Object.entries(selected)) {
    const filename = path.join(root, relative)
    let text = canonicalLf(read(filename))
    if (relative === versions.sourcePath) {
      assert.equal(sha256(text), versions.fixedSha256, 'Fixed reader drift')
      if (variant === 'before') {
        text = applyPatch(text, reversePatch(targetPatch))
        assert.notEqual(text, false, 'Reader patch no longer reverses')
        assert.equal(sha256(text), versions.baselineSha256)
      }
    } else if (relative === versions.contextPath) {
      const actual = sha256(text)
      assert.ok(
        actual === versions.worktreeGraph[relative] || actual === versions.mainGraph[relative],
        'Unaudited writer context'
      )
      if (actual !== expected) {
        text = applyPatch(text, graph === 'main' ? contextPatch : reversePatch(contextPatch))
        assert.notEqual(text, false, 'Writer context no longer reconstructs')
      }
      assert.equal(sha256(text), expected)
    } else {
      assert.equal(sha256(text), expected, `Graph source drift: ${relative}`)
    }
    hashes[relative] = sha256(text)
    sources.set(filename, text)
  }
  for (const [relative, expected] of Object.entries(versions.callerHashes)) {
    assert.equal(
      sha256(canonicalLf(read(path.join(root, relative)))),
      expected,
      `Caller drift: ${relative}`
    )
  }
  const reader = sources.get(path.join(root, versions.sourcePath))
  return {
    root,
    sources,
    hashes,
    observedReaderSha256: sha256(observePending(reader)),
    graph,
    variant
  }
}

module.exports = { loadSources, observePending, readText, versions }
