import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  openSync,
  writeSync,
  closeSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'

const packet = import.meta.dirname,
  root = resolve(packet, '../../..')
const output = resolve(root, 'r4-evidence'),
  prefix = 'config/ci/pr35764-r4/'
const productionHead = '2dbb5681fad6542581f0d8802120faccb371a20f'
const subject = 'PR35764 R4 one held engine comparison'
const overlayFiles = [
  'engine/logging-only.diff',
  'engine/observed-index.source',
  'engine/original-index.source',
  'input-pins.json',
  'installation-metadata.mjs',
  'package-resolution.mjs',
  'module-observation.mjs',
  'retained/editor-surface.ts',
  'retained/mapping-contracts.ts',
  'retained/release-contracts.ts',
  'retained/focus-contracts.ts',
  'n1-acceptance-contract.test.tsx',
  'observer.setup.mjs',
  'protocols/current.source',
  'protocols/main.source',
  'protocols/ordered-a.source',
  'protocols/routed.ts',
  'retained/adversarial.ts',
  'retained/lifetime.ts',
  'run-once.mjs',
  'source/main-rich-markdown-editor-config.source',
  'source/main-rich-markdown-selection-flush.source',
  'vitest.config.mjs'
].map((file) => prefix + file)
const allowedChanges = [...overlayFiles, '.github/workflows/pr35764-r4-once.yml']
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const save = (name, value) =>
  writeFileSync(resolve(output, name), JSON.stringify(value, null, 2), { flag: 'wx' })
function identity() {
  if (
    process.env.CI !== 'true' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    process.env.GITHUB_EVENT_NAME !== 'push' ||
    process.env.GITHUB_REF !== 'refs/heads/brennanb2025/sta-12544-md-find-anchor'
  ) {
    throw new Error('R4 hosted first-push identity refused')
  }
  if (process.env.ORCA_PNPM_FORCE_GLOBAL_VIRTUAL_STORE_IN_CI === '1') {
    throw new Error('R4 requires ordinary CI store policy')
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const head = git('rev-parse', 'HEAD')
  if (
    head !== process.env.GITHUB_SHA ||
    event.before !== productionHead ||
    git('show', '-s', '--format=%P', 'HEAD') !== productionHead ||
    git('show', '-s', '--format=%s', 'HEAD') !== subject
  ) {
    throw new Error('R4 requires one temporary child commit of unchanged2db')
  }
  const changed = git('diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD').split('\n')
  if (
    changed.length !== allowedChanges.length ||
    changed.some((line) => {
      const [status, path] = line.split('\t')
      return status !== 'A' || !allowedChanges.includes(path)
    })
  ) {
    throw new Error('R4 temporary commit touched an original or unlisted source')
  }
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('R4 tracked/index inputs dirty')
  }
  const pins = JSON.parse(readFileSync(resolve(packet, 'input-pins.json'), 'utf8'))
  if (pins.productionHead !== productionHead) {
    throw new Error('R4 input authority differs')
  }
  for (const [path, expected] of Object.entries(pins.files)) {
    if (sha(readFileSync(resolve(root, path))) !== expected) {
      throw new Error(`R4 unchanged2db bytes differ: ${path}`)
    }
  }
  return {
    head,
    productionHead,
    mainSelectionRouteHead: pins.mainSelectionRouteHead,
    changed,
    unchangedInputCount: Object.keys(pins.files).length,
    pinInventorySha256: sha(readFileSync(resolve(packet, 'input-pins.json'))),
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    platform: process.platform,
    executable: process.execPath,
    utc: new Date().toISOString()
  }
}
const mode = process.argv[2]
if (process.argv.length !== 3 || !['guard', 'run', 'seal'].includes(mode)) {
  throw new Error('R4 literal mode required')
}
if (mode === 'guard') {
  mkdirSync(output)
  try {
    save('setup-identity.json', identity())
  } catch (error) {
    save('setup-refusal.json', { error: String(error), engineStarted: false })
    throw error
  }
} else if (mode === 'run') {
  const receipt = identity()
  if (
    process.versions.bun ||
    !process.versions.node.startsWith('24.') ||
    process.execArgv.length ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.env.ORCA_UNIT_MODULE_CACHE_PATH
  ) {
    throw new Error('R4 direct cold Node24 resolution required')
  }
  const args = [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    `${prefix}vitest.config.mjs`,
    `${prefix}n1-acceptance-contract.test.tsx`,
    '--maxWorkers=1',
    '--project=n1-main',
    '--project=n1-current',
    '--project=n1-ordered',
    '--project=n1-routed',
    '--reporter=default',
    '--reporter=json',
    '--outputFile.json=r4-evidence/vitest-results.json'
  ]
  save('invocation-claim.json', {
    ...receipt,
    pid: process.pid,
    command: [process.execPath, ...args],
    plannedStaticCases: { main: 23, current: 42, ordered: 42, routed: 42 },
    staticTotal: 149,
    countsAreNotExecutedEvidence: true,
    noRetry: true
  })
  const streams = ['stdout', 'stderr'].map((name) => ({
    name,
    fd: openSync(resolve(output, `${name}.raw`), 'wx'),
    bytes: 0,
    received: 0,
    overflow: false
  }))
  const child = spawn(process.execPath, args, {
    cwd: root,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  save('child-start.json', {
    pid: child.pid ?? null,
    startUtc: new Date().toISOString(),
    command: [process.execPath, ...args]
  })
  for (const [index, pipe] of [child.stdout, child.stderr].entries()) {
    pipe.on('data', (chunk) => {
      const stream = streams[index],
        take = Math.min(chunk.length, 64 * 1024 * 1024 - stream.bytes)
      stream.received += chunk.length
      let written = 0
      while (written < take) {
        const count = writeSync(stream.fd, chunk, written, take - written)
        if (count <= 0) {
          throw new Error('R4 stream persistence made no progress')
        }
        written += count
        stream.bytes += count
      }
      if (take !== chunk.length) {
        stream.overflow = true
      }
    })
  }
  let spawnError = null
  child.on('error', (error) => {
    spawnError = String(error)
  })
  child.on('close', (code, signal) => {
    for (const stream of streams) {
      closeSync(stream.fd)
    }
    save('actual-exit.json', {
      code,
      signal,
      spawnError,
      finishedUtc: new Date().toISOString(),
      streams: streams.map(({ fd: _fd, ...rest }) => rest),
      noRetry: true,
      incomplete: Boolean(spawnError || signal || streams.some((stream) => stream.overflow))
    })
    process.exitCode =
      code !== null && code !== 0
        ? code
        : spawnError || signal || streams.some((stream) => stream.overflow)
          ? 2
          : 0
  })
} else {
  save('job-outcome.json', {
    installOutcome: process.env.R4_INSTALL_OUTCOME || null,
    engineStepOutcome: process.env.R4_ENGINE_OUTCOME || null,
    utc: new Date().toISOString(),
    absentActualExitMeansIncomplete: true,
    noRetryGrant: true
  })
  const files = readdirSync(output).sort()
  if (files.length > 220) {
    throw new Error('R4 evidence file count overflow')
  }
  let total = 0
  const inventory = files.map((name) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error('R4 unexpected evidence member')
    }
    const path = resolve(output, name),
      info = lstatSync(path)
    if (!info.isFile() || info.size > 64 * 1024 * 1024) {
      throw new Error('R4 evidence member overflow/type')
    }
    total += info.size
    return { name, bytes: info.size, sha256: sha(readFileSync(path)) }
  })
  if (total > 12 * 1024 * 1024 * 1024) {
    throw new Error('R4 aggregate evidence overflow')
  }
  save('artifact-inventory.json', {
    inventory,
    total,
    runtimeResultMayBeAbsent: true,
    engineRelease: false
  })
}
