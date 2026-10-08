const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { parityCases, sessionId } = require('./parity-cases.cjs')
const { compareAllocation } = require('./allocation.cjs')
const { compareGrowth } = require('./growth.cjs')
const { compareDuration } = require('./duration.cjs')
const { verifierEntry, compareVerifier } = require('./verifier.cjs')

const { root, sourcePath, sourceRelativePath, baseline, candidate, windowCandidate } =
  require('./sources.cjs')()
const { buildSync } = createRequire(path.join(root, 'package.json'))('esbuild')
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || !global.gc) {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1 and node --expose-gc.')
}
const hash = (text) => createHash('sha256').update(text).digest('hex')
const verifierPath = 'src/main/runtime/orca-runtime-stop-structured-session-process.ts'
const verifierSource = fs.readFileSync(path.join(root, verifierPath), 'utf8')
const scratch = fs.mkdtempSync(path.join(tmpdir(), 'orca-claude-branch-streaming-'))
const modulePaths = []

async function capture(action) {
  try {
    return { status: 'fulfilled', value: await action() }
  } catch (error) {
    return {
      status: 'rejected',
      name: error.name,
      message: error.message,
      ...(error.code ? { code: error.code } : {})
    }
  }
}

async function run() {
  const provenance = require('./provenance.json')
  for (const file of provenance.files) {
    const source = fs.readFileSync(path.join(root, file.path), 'utf8')
    assert.equal(hash(source), file.currentSha256, `Refresh provenance for ${file.path}`)
    const lines = source.split('\n')
    for (const site of file.currentCallSites) {
      assert.equal(lines[site.line - 1].trim(), site.text, `${file.path}:${site.line}`)
    }
  }
  const auditHashes = {}
  for (const file of fs.readdirSync(__dirname)) {
    if (
      file.endsWith('.cjs') ||
      file.endsWith('.mjs') ||
      ['candidate-transform.json', 'fix.patch', 'provenance.json'].includes(file)
    ) {
      auditHashes[file] = hash(fs.readFileSync(path.join(__dirname, file)))
    }
  }
  const modules = {}
  const sourceHashes = {}
  const bundleHashes = {}
  for (const [phase, contents] of Object.entries({ baseline, candidate, windowCandidate })) {
    const built = buildSync({
      stdin: {
        contents: contents + verifierEntry(verifierSource),
        sourcefile: sourcePath,
        resolveDir: path.dirname(sourcePath),
        loader: 'ts'
      },
      absWorkingDir: root,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      metafile: true
    })
    const modulePath = path.join(scratch, `${phase}.cjs`)
    fs.writeFileSync(modulePath, built.outputFiles[0].text)
    modulePaths.push(modulePath)
    modules[phase] = require(modulePath)
    bundleHashes[phase] = hash(built.outputFiles[0].text)
    for (const input of Object.keys(built.metafile.inputs)) {
      if (path.resolve(root, input) !== sourcePath) {
        sourceHashes[input] = hash(fs.readFileSync(path.resolve(root, input)))
      }
    }
  }
  sourceHashes[sourceRelativePath] = {
    baseline: hash(baseline),
    candidate: hash(candidate),
    windowCandidate: hash(windowCandidate)
  }
  sourceHashes[verifierPath] = hash(verifierSource)
  const parity = []
  for (const scenario of parityCases()) {
    const file = path.join(scratch, 'parity.jsonl')
    fs.writeFileSync(file, scenario.contents)
    const input = { providerSessionId: sessionId, previousLeafUuid: null, ...scenario.options }
    const outcomes = {}
    for (const [phase, methods] of Object.entries(modules)) {
      outcomes[`${phase}File`] = await capture(() =>
        methods.proveClaudeTranscriptBranch({ ...input, transcriptPath: file })
      )
      outcomes[`${phase}String`] = await capture(() =>
        methods.proveClaudeTranscriptBranchFromJsonl({
          ...input,
          contents: Buffer.from(scenario.contents).toString('utf8')
        })
      )
    }
    for (const outcome of Object.values(outcomes)) {
      assert.deepEqual(outcome, outcomes.baselineFile, scenario.name)
    }
    assert.equal(
      outcomes.baselineFile.status,
      scenario.error ? 'rejected' : 'fulfilled',
      scenario.name
    )
    if (scenario.error) {
      assert.equal(outcomes.baselineFile.name, scenario.error, scenario.name)
    }
    parity.push({
      name: scenario.name,
      sourceBytes: fs.statSync(file).size,
      outcome: outcomes.baselineFile
    })
    fs.unlinkSync(file)
  }
  const missing = {}
  for (const [phase, methods] of Object.entries(modules)) {
    missing[phase] = await capture(() =>
      methods.proveClaudeTranscriptBranch({
        transcriptPath: path.join(scratch, 'missing'),
        providerSessionId: sessionId,
        previousLeafUuid: null
      })
    )
    assert.equal(missing[phase].code, 'ENOENT')
  }
  const growth = await compareGrowth(scratch, modules)
  const allocations = await compareAllocation(scratch, modules)
  const duration = await compareDuration(scratch, modules)
  const verifier = await compareVerifier(scratch, modules)
  const report = {
    status:
      'Actual production source; baseline reconstructed by reverse fix.patch; open-ended experiment retained as a control',
    measurement:
      'Forced GC at actual JSON.parse boundaries; sampled transient live bytes, not RSS, natural peak, or a retained-leak proof.',
    runtime: {
      node: process.version,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch
    },
    toolVersions: {
      esbuild: require('esbuild/package.json').version,
      diff: require('diff/package.json').version
    },
    auditHashes,
    sourceHashes,
    bundleHashes,
    parity,
    missingFile: 'All three readers reject with ENOENT',
    growth,
    allocations,
    duration,
    verifier
  }
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (process.argv[2]) {
    fs.writeFileSync(path.resolve(process.argv[2]), output)
  }
  process.stdout.write(output)
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    for (const modulePath of modulePaths) {
      delete require.cache[require.resolve(modulePath)]
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  })
