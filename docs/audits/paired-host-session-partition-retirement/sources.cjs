const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { applyPatch, parsePatch, reversePatch } = require('diff')

const root = path.resolve(__dirname, '../../..')
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
const sha = (text) => createHash('sha256').update(text).digest('hex')
const versions = JSON.parse(read(path.join(__dirname, 'source-versions.json')))
const flavors = ['currentFixed', 'mainFixed', 'currentBefore', 'mainBefore']

function checkMap(sources, flavor) {
  for (const [file, expected] of Object.entries(versions.sources)) {
    const actual = sources[file] === null ? null : sha(sources[file])
    assert.equal(actual, expected[flavor], `${flavor} source drift: ${file}`)
  }
}

function transition(sources, patchName, reverse, flavor) {
  const result = { ...sources }
  for (const original of parsePatch(read(path.join(__dirname, patchName)))) {
    const patch = reverse ? reversePatch(original) : original
    const file = (patch.newFileName === '/dev/null' ? patch.oldFileName : patch.newFileName).slice(
      2
    )
    assert.ok(Object.hasOwn(versions.sources, file), `Unfenced patch path: ${file}`)
    const updated = applyPatch(result[file] ?? '', patch)
    assert.notEqual(updated, false, `Patch failed: ${patchName}:${file}`)
    if (versions.sources[file][flavor] === null) {
      assert.equal(updated, '', `Deleted source is not empty: ${file}`)
      result[file] = null
    } else {
      result[file] = updated
    }
  }
  checkMap(result, flavor)
  return result
}

function loadVariants(readSource) {
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
  const physical = {}
  for (const file of Object.keys(versions.sources)) {
    const absolute = path.join(root, file)
    const source = readSource ? readSource(file) : existsSync(absolute) ? read(absolute) : null
    physical[file] = source?.replaceAll('\r\n', '\n') ?? null
  }
  const physicalHashes = Object.fromEntries(
    Object.entries(physical).map(([file, source]) => [file, source === null ? null : sha(source)])
  )
  const flavor = flavors.find((candidate) =>
    Object.entries(versions.sources).every(
      ([file, expected]) => physicalHashes[file] === expected[candidate]
    )
  )
  assert.ok(
    flavor,
    'Working source graph matches no exact audited/publication before/fixed identity'
  )
  const runnerHashes = {}
  for (const [file, expected] of Object.entries(versions.runnerSources)) {
    const actual = sha(read(path.join(root, file)))
    const accepted = Array.isArray(expected) ? expected : [expected]
    assert.ok(accepted.includes(actual), `Runner source drift: ${file}`)
    runnerHashes[file] = actual
  }
  let fixed = physical
  if (flavor === 'currentBefore') {
    fixed = transition(fixed, 'fix.patch', false, 'currentFixed')
  } else if (flavor === 'mainBefore') {
    fixed = transition(fixed, 'main-fix.patch', false, 'mainFixed')
  }
  if (flavor.startsWith('main')) {
    fixed = transition(fixed, 'publication.patch', true, 'currentFixed')
  }
  const currentBefore = transition(fixed, 'fix.patch', true, 'currentBefore')
  const mainFixed = transition(fixed, 'publication.patch', false, 'mainFixed')
  const mainBefore = transition(mainFixed, 'main-fix.patch', true, 'mainBefore')
  const recovery = 'src/main/runtime/runtime-legacy-worker-terminal-recovery-persistence.ts'
  return {
    flavor,
    runnerHashes,
    maps: {
      'current-fixed': fixed,
      'current-before': currentBefore,
      'current-without-rollback': { ...fixed, [recovery]: currentBefore[recovery] },
      'main-fixed': mainFixed,
      'main-before': mainBefore,
      'main-without-rollback': { ...mainFixed, [recovery]: mainBefore[recovery] }
    }
  }
}

function phasePlugin(phase) {
  const loaded = loadVariants()
  const sources = loaded.maps[phase]
  const expected = versions.evaluated[phase]
  assert.ok(sources && expected, `Unknown proof phase: ${phase}`)
  const evaluated = {}
  const relative = (file) => path.relative(root, file.split('?')[0]).replaceAll('\\', '/')
  process.once('exit', () => {
    if (process.env.ORCA_PARTITION_EVALUATED) {
      writeFileSync(
        process.env.ORCA_PARTITION_EVALUATED,
        JSON.stringify({ workingFlavor: loaded.flavor, hashes: evaluated }, null, 2)
      )
    }
  })
  return {
    name: 'fenced-paired-host-partition-sources',
    enforce: 'pre',
    resolveId(specifier, importer) {
      if (!importer || !specifier.startsWith('.') || !relative(importer).startsWith('src/')) {
        return undefined
      }
      const stem = path.resolve(path.dirname(importer), specifier)
      for (const candidate of [
        stem,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.js`,
        path.join(stem, 'index.ts')
      ]) {
        const file = relative(candidate)
        if (sources[file] != null) {
          return candidate
        }
      }
      return undefined
    },
    load(id) {
      const file = relative(id)
      return Object.hasOwn(sources, file) && sources[file] !== null ? sources[file] : undefined
    },
    transform(_source, id) {
      const file = relative(id)
      if (!file.startsWith('src/')) {
        return undefined
      }
      if (versions.runnerSources[file]) {
        assert.equal(sha(_source.replaceAll('\r\n', '\n')), loaded.runnerHashes[file])
        return undefined
      }
      assert.ok(expected[file], `Unfenced evaluated module: ${phase}:${file}`)
      assert.equal(
        sha(sources[file]),
        expected[file],
        `Evaluated source mismatch: ${phase}:${file}`
      )
      evaluated[file] = sha(sources[file])
      return { code: sources[file], map: null }
    }
  }
}

module.exports = { root, sha, read, versions, loadVariants, phasePlugin }
