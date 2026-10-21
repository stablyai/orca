const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { build } = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}
if (process.argv[2] === '--proof-child' && typeof global.gc !== 'function') {
  throw new Error('Child proof requires --expose-gc')
}
const root = resolve(__dirname, '../../..')
const readSource = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const sourcePath = join(root, 'src/main/project-groups/nested-repo-discovery.ts')
const original = readSource(sourcePath)
const patch = parsePatch(readSource(join(__dirname, 'fix.patch')))
assert.equal(patch.length, 1)
const baseline = applyPatch(original, reversePatch(patch[0]))
assert.notEqual(baseline, false, 'Source changed; review fix.patch')
const hookPoint = '    if (currentFolder.depth > options.maxDepth) {'
assert.equal(original.split(hookPoint).length, 2)
assert.equal(baseline.split(hookPoint).length, 2)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const scratch = mkdtempSync(join(tmpdir(), 'orca-nested-queue-proof-'))
const branchCount = 96
const rulesPerBranch = 64
const pauseLeaf = branchCount - 2
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function gc() {
  for (let round = 0; round < 4; round++) {
    await tick()
    global.gc()
  }
}
async function run(mode) {
  const output = join(scratch, `${mode}.cjs`)
  let source = mode === 'after' ? original : baseline
  if (mode === 'clear-consumed-slot') {
    const dequeue = '    const currentFolder = foldersToTraverse[nextFolderIndex++]'
    assert.equal(source.split(dequeue).length, 2)
    source = source.replace(
      dequeue,
      `${dequeue}\n    foldersToTraverse[nextFolderIndex - 1] = undefined`
    )
  }
  const observedSource = source.replace(
    hookPoint,
    `    globalThis.__orcaObserveNestedQueue(currentFolder, foldersToTraverse, nextFolderIndex)\n${
      hookPoint
    }`
  )
  await build({
    entryPoints: [sourcePath],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [
      {
        name: 'observe-actual-nested-queue',
        setup(build) {
          build.onLoad({ filter: /nested-repo-discovery\.ts$/ }, () => ({
            contents: observedSource,
            loader: 'ts',
            resolveDir: join(root, 'src/main/project-groups')
          }))
          build.onResolve({ filter: /^\.\.\/git\/repo$/ }, () => ({
            path: 'inert-git',
            namespace: 'proof'
          }))
          build.onLoad({ filter: /.*/, namespace: 'proof' }, () => ({
            contents:
              'export function isGitRepo() { throw new Error("fixture must use injected filesystem") }',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const { scanNestedRepos } = require(output)
  const references = []
  const visits = []
  let pausedState
  globalThis.__orcaObserveNestedQueue = (current, queue, head) => {
    references.push({
      path: current.path,
      record: new WeakRef(current),
      inheritedRules: new WeakRef(current.ignoreRules)
    })
    if (current.path === `/fixture/b${String(pauseLeaf).padStart(3, '0')}/leaf`) {
      pausedState = {
        allocatedSlots: queue.length,
        consumedSlots: head,
        pendingSlots: queue.length - head,
        occupiedConsumedSlots: queue.slice(0, head).filter(Boolean).length
      }
    }
  }
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let markPaused
  const paused = new Promise((resolve) => {
    markPaused = resolve
  })
  const resultPromise = scanNestedRepos({
    path: '/fixture',
    options: { maxDepth: 3 },
    filesystem: {
      async readDirectory(path) {
        visits.push(path)
        if (path === '/fixture') {
          return Array.from({ length: branchCount }, (_, index) => ({
            name: `b${String(index).padStart(3, '0')}`,
            isDirectory: true
          }))
        }
        if (!path.endsWith('/leaf')) {
          return [
            { name: '.gitignore', isDirectory: false },
            { name: 'leaf', isDirectory: true }
          ]
        }
        if (path === `/fixture/b${String(pauseLeaf).padStart(3, '0')}/leaf`) {
          markPaused()
          await gate
        }
        return []
      },
      async readTextFile(path) {
        return Array.from(
          { length: rulesPerBranch },
          (_, index) => `${path.replaceAll('/', '_')}_unused_${index}`
        ).join('\n')
      },
      joinPath: (parent, name) => `${parent}/${name}`,
      basename: (path) => path.split('/').at(-1),
      hasGitMarker: () => false,
      isSelectedPathGitRepo: () => false
    }
  })
  await paused
  await gc()
  const completedLeaves = references.filter(
    ({ path }) =>
      path.endsWith('/leaf') && path !== `/fixture/b${String(pauseLeaf).padStart(3, '0')}/leaf`
  )
  const retained = {
    completedLeaves: completedLeaves.length,
    retainedCompletedRecords: completedLeaves.filter(({ record }) => record.deref()).length,
    retainedCompletedRuleArrays: completedLeaves.filter(({ inheritedRules }) =>
      inheritedRules.deref()
    ).length
  }
  release()
  const result = await resultPromise
  delete globalThis.__orcaObserveNestedQueue
  await gc()
  const afterCompletion = references.filter(({ record }) => record.deref()).length
  assert.equal(result.repos.length, 0)
  assert.equal(result.stopped, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.timeoutMs, null)
  assert.equal(visits.length, branchCount * 2 + 1)
  assert.equal(new Set(visits).size, visits.length)
  assert.equal(pausedState.pendingSlots, 1)
  assert.equal(retained.completedLeaves, pauseLeaf)
  assert.equal(afterCompletion, 0)
  delete require.cache[require.resolve(output)]
  return {
    mode,
    pausedState,
    retained,
    afterCompletion,
    totalVisited: visits.length,
    visitedOrder: visits
  }
}
async function main() {
  try {
    if (process.argv[2] !== '--proof-child') {
      const runnerPath = join(scratch, 'run-process.cjs')
      await build({
        entryPoints: [join(root, 'src/shared/child-process/run-process.ts')],
        outfile: runnerPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      const { runProcess } = require(runnerPath)
      const child = await runProcess({
        program: process.execPath,
        args: ['--expose-gc', '--max-old-space-size=256', __filename, '--proof-child'],
        cwd: root,
        env: process.env,
        timeoutMs: 15_000,
        maxOutputBytes: 1024 * 1024
      })
      assert.equal(child.timedOut, false, 'Proof timed out')
      assert.equal(child.code, 0, child.stderr || child.stdout)
      const recorded = JSON.parse(child.stdout)
      const historical = await runProcess({
        program: 'git',
        args: ['show', 'v1.4.198:src/main/project-groups/nested-repo-discovery.ts'],
        cwd: root,
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024
      })
      assert.equal(historical.timedOut, false)
      assert.equal(historical.code, 0)
      const historicalHash = sha256(historical.stdout.replace(/\r\n/g, '\n'))
      assert.equal(historicalHash, recorded.sourceHashes.before)
      console.log(
        JSON.stringify(
          {
            ...recorded,
            historicalSource: { ref: 'v1.4.198', sha256: historicalHash, equalsBaseline: true },
            process: {
              exitCode: child.code,
              timedOut: child.timedOut,
              timeoutMs: 15_000,
              oldSpaceMiB: 256
            }
          },
          null,
          2
        )
      )
      delete require.cache[require.resolve(runnerPath)]
      return
    }
    const before = await run('before')
    const control = await run('clear-consumed-slot')
    const after = await run('after')
    assert.equal(before.retained.retainedCompletedRecords, pauseLeaf)
    assert.equal(before.retained.retainedCompletedRuleArrays, pauseLeaf)
    for (const phase of [control, after]) {
      assert.equal(phase.retained.retainedCompletedRecords, 0)
      assert.equal(phase.retained.retainedCompletedRuleArrays, 0)
      assert.equal(phase.pausedState.occupiedConsumedSlots, 0)
      assert.deepEqual(before.visitedOrder, phase.visitedOrder)
    }
    assert.ok(after.pausedState.allocatedSlots <= 64)
    for (const phase of [before, control, after]) {
      delete phase.visitedOrder
    }
    console.log(
      JSON.stringify({
        description:
          'Actual nested-repo scan with observational dequeue hook; before reverses fix.patch and control clears only consumed slots.',
        sourceHashes: {
          normalization: 'UTF-8 source with CRLF line endings normalized to LF',
          before: sha256(baseline),
          after: sha256(original),
          rules: sha256(
            readSource(join(root, 'src/main/project-groups/nested-repo-scan-rules.ts'))
          ),
          regression: sha256(
            readSource(join(root, 'src/main/project-groups/nested-repo-discovery-queue.test.ts'))
          ),
          runner: sha256(readSource(__filename))
        },
        nodeVersion: process.version,
        branchCount,
        rulesPerBranch,
        before,
        control,
        after,
        passed: true
      })
    )
  } finally {
    delete globalThis.__orcaObserveNestedQueue
    rmSync(scratch, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
