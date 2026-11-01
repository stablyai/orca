import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, version as esbuildVersion } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { nodeExecutable } from '../../../../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import { workload } from '../../../../../config/scripts/check-job-log-performance-cases.mjs'

const require = createRequire(import.meta.url)
export const hash = (value) => createHash('sha256').update(value).digest('hex')
const fixtureSource = `
let output = ''; let failed = false; let downloads = 0;
export function setFixtureOutput(value, error = false) { output = value; failed = error; }
export function downloadCount() { return downloads; }
export async function ghExecFileAsync() {
 downloads++;
 if (failed) throw Object.assign(new Error('fixture failed'), { code: 1, stderr: 'fixture ordinary failure' });
 return { stdout: output, stderr: '' };
}
`
const scriptUrl = (name) => new URL(name, import.meta.url)
const scriptRoot = fileURLToPath(scriptUrl('../../../../../'))
const sourceName = (root, filename) => path.relative(root, filename).split(path.sep).join('/')
const cpuDescriptors = [8, 63].map((size) => ({
  mode: 'cpu',
  family: 'short-lines',
  bytes: size * 1024 * 1024,
  generator: 'config/scripts/check-job-log-performance-cases.mjs#workload'
}))

export async function prepareHostMeasurement(root = process.cwd()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-check-host-retention-'))
  try {
    const bundle = await build({
      absWorkingDir: root,
      stdin: {
        contents:
          "export { attachFailedJobLogTails, prCheckLogTailCache } from './check-job-log-tails'; export { setFixtureOutput, downloadCount } from '../../gh-utils';",
        resolveDir: path.join(root, 'src', 'main', 'github', 'client', 'check'),
        loader: 'ts'
      },
      platform: 'node',
      format: 'esm',
      bundle: true,
      write: false,
      metafile: true,
      plugins: [
        {
          name: 'generated-gh-capture-result',
          setup(builder) {
            builder.onResolve({ filter: /^\.\.\/\.\.\/gh-utils$/ }, () => ({
              path: 'generated-gh-result',
              namespace: 'fixture'
            }))
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: fixtureSource,
              loader: 'js'
            }))
          }
        }
      ]
    })
    const bundleSources = Object.keys(bundle.metafile.inputs)
      .filter((name) => name !== '<stdin>' && !name.startsWith('fixture:'))
      .sort()
    const executedSources = [
      import.meta.filename,
      fileURLToPath(scriptUrl('./check-job-log-cache-retention-child.mjs')),
      fileURLToPath(scriptUrl('../../../../../config/scripts/check-job-log-performance-cases.mjs')),
      fileURLToPath(scriptUrl('../../../../../config/scripts/check-job-log-byte-cap-benchmark.mjs'))
    ].map((filename) => sourceName(scriptRoot, filename))
    const sourceHashes = {}
    for (const name of [...new Set([...bundleSources, ...executedSources])].sort()) {
      sourceHashes[name] = hash(await readFile(path.join(root, name)))
    }
    const program = await realpath(nodeExecutable())
    const processHostEntry = require.resolve('@orca/process-host')
    const processHostDirectory = path.dirname(processHostEntry)
    const processHostModules = {}
    for (const filename of Object.keys(require.cache)
      .filter((filename) => filename.startsWith(`${processHostDirectory}${path.sep}`))
      .sort()) {
      processHostModules[sourceName(path.dirname(processHostDirectory), filename)] = hash(
        await readFile(filename)
      )
    }
    const identity = {
      sourceHashes,
      bundleSources,
      executedSources: executedSources.sort(),
      bundleHash: hash(bundle.outputFiles[0].text),
      tools: {
        node: {
          executable: path.basename(program),
          resolvedExecutableHash: hash(program),
          binaryHash: hash(await readFile(program))
        },
        esbuild: {
          version: esbuildVersion,
          entryHash: hash(await readFile(require.resolve('esbuild')))
        },
        processHost: {
          version: JSON.parse(await readFile(path.join(processHostDirectory, '..', 'package.json')))
            .version,
          loadedModuleHashes: processHostModules
        }
      },
      cpuDescriptors
    }
    const bundlePath = path.join(directory, 'host-cache.mjs')
    await writeFile(bundlePath, bundle.outputFiles[0].text)
    return {
      root,
      program,
      bundlePath,
      identity,
      identityHash: hash(JSON.stringify(identity)),
      cleanup: () => rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export function validateHostRecord(context, record) {
  assert.equal(record.identityHash, context.identityHash, 'Measurement identity mismatch')
  assert.equal(
    record.runtime.executableHash,
    context.identity.tools.node.resolvedExecutableHash,
    'Node selection mismatch'
  )
  assert(record.runtime.gc && record.runtime.background, 'Measurement runtime policy mismatch')
  assert.equal(record.cpu.length, context.identity.cpuDescriptors.length)
  for (const [index, descriptor] of context.identity.cpuDescriptors.entries()) {
    const measured = record.cpu[index]
    assert.deepEqual(measured.workload, descriptor, 'CPU workload descriptor mismatch')
    const generated = workload(descriptor)
    assert.equal(measured.inputBytes, Buffer.byteLength(generated.text), 'CPU input size mismatch')
    assert.equal(measured.inputHash, hash(generated.text), 'CPU input hash mismatch')
  }
}

export async function runHostMeasurement(context) {
  const records = []
  for (let trial = 0; trial < 3; trial++) {
    const result = await runProcess({
      program: context.program,
      args: [
        '--expose-gc',
        fileURLToPath(scriptUrl('./check-job-log-cache-retention-child.mjs')),
        context.bundlePath,
        String(trial),
        JSON.stringify({
          identityHash: context.identityHash,
          cpuDescriptors: context.identity.cpuDescriptors
        })
      ],
      cwd: context.root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      maxOutputBytes: 32 * 1024
    })
    assert(
      !result.timedOut && !result.signal && result.code === 0 && !result.outputTruncated,
      'Host measurement child failed or exceeded its external process timeout'
    )
    assert.equal(result.stderr, '', 'Host measurement child emitted diagnostics')
    const record = JSON.parse(result.stdout)
    assert.equal(record.trial, trial, 'Measurement trial mismatch')
    validateHostRecord(context, record)
    records.push(record)
  }
  return {
    identity: context.identity,
    identityHash: context.identityHash,
    externalProcessTimeoutMs: 20_000,
    maxOutputBytesPerStream: 32 * 1024,
    rawCapture:
      'generated gh success boundary; actual host download/inflight/cache/extractor/sanitation',
    records
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const context = await prepareHostMeasurement()
  try {
    const report = await runHostMeasurement(context)
    if (process.env.ORCA_CHECK_LOG_HOST_REPORT) {
      await writeFile(process.env.ORCA_CHECK_LOG_HOST_REPORT, JSON.stringify(report, null, 2))
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    await context.cleanup()
  }
}
