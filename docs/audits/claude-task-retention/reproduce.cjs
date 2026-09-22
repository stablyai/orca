const fs = require('node:fs')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '../../..')
const bundles = {}

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')

async function loadTracker(fixed) {
  const result = await build({
    entryPoints: [path.join(root, 'src/main/claude/claude-background-task-tracker.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    plugins: fixed
      ? []
      : [
          {
            name: 'baseline-without-task-text-copy',
            setup(builder) {
              builder.onLoad({ filter: /claude-background-task-frames\.ts$/ }, (args) => {
                const source = fs.readFileSync(args.path, 'utf8')
                const boundary = 'ownRetainedString(trimmed.slice(0, MAX_TASK_TEXT_LENGTH))'
                assert.ok(
                  source.includes(boundary),
                  'The copy boundary changed; update the baseline transform'
                )
                return {
                  loader: 'ts',
                  contents: source.replace(boundary, 'trimmed.slice(0, MAX_TASK_TEXT_LENGTH)')
                }
              })
            }
          }
        ]
  })
  bundles[fixed ? 'after' : 'before'] = createHash('sha256')
    .update(result.outputFiles[0].text)
    .digest('hex')
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'orca-claude-task-proof-'))
  let moduleId
  try {
    const bundlePath = path.join(scratch, 'tracker.cjs')
    fs.writeFileSync(bundlePath, result.outputFiles[0].text)
    moduleId = require.resolve(bundlePath)
    return require(moduleId).ClaudeBackgroundTaskTracker
  } finally {
    if (moduleId) {
      delete require.cache[moduleId]
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

function collect() {
  for (let i = 0; i < 5; i++) {
    global.gc()
  }
  return process.memoryUsage().heapUsed
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function frame(index, size, ingress, field) {
  const value = String.fromCharCode(65 + (index % 26)).repeat(size)
  const message = {
    type: 'system',
    subtype: 'task_started',
    task_id: `task-${index}`,
    task_type: 'local_bash',
    is_backgrounded: true,
    [field]: value
  }
  if (ingress === 'json') {
    return JSON.parse(JSON.stringify(message))
  }
  if (ingress === 'flat') {
    value.charCodeAt(value.length - 1)
  }
  return message
}

function populate(Tracker, { count, size, ingress, retention, field }) {
  const owner = new Tracker()
  const keeper = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'keeper',
    task_type: 'local_bash',
    is_backgrounded: true
  }
  if (retention !== 'live') {
    owner.observe(keeper)
  }
  for (let index = 0; index < count; index++) {
    owner.observe(frame(index, size, ingress, field))
    if (retention === 'settled') {
      owner.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: `task-${index}`,
        status: 'completed'
      })
    }
  }
  if (retention === 'removed') {
    owner.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [keeper] })
  }
  return owner
}

function logicalChars(owner) {
  const state = owner.state
  return [...(state?.tasks ?? []), ...(state?.settledTasks ?? [])].reduce(
    (sum, task) => sum + (task.description?.length ?? 0) + (task.name?.length ?? 0),
    0
  )
}

async function main() {
  const Before = await loadTracker(false)
  const Fixed = await loadTracker(true)
  for (const Tracker of [Before, Fixed]) {
    const warm = populate(Tracker, {
      count: 1,
      size: 1024,
      ingress: 'json',
      retention: 'live',
      field: 'description'
    })
    warm.clear()
  }
  const results = []
  for (const [count, size] of [
    [32, 64 * 1024],
    [8, 4 * 1024 * 1024]
  ]) {
    for (const ingress of ['flat', 'cons', 'json']) {
      for (const retention of ['live', 'settled', 'removed']) {
        for (const [phase, Tracker] of [
          ['before', Before],
          ['after', Fixed]
        ]) {
          await settle()
          const baseline = collect()
          global.auditTaskOwner = populate(Tracker, {
            count,
            size,
            ingress,
            retention,
            field: 'description'
          })
          await settle()
          const retainedHeapBytes = collect() - baseline
          const visibleTextChars = logicalChars(global.auditTaskOwner)
          global.auditTaskOwner.clear()
          global.auditTaskOwner = null
          await settle()
          const afterClearHeapBytes = collect() - baseline
          if (phase === 'after') {
            assert.ok(retainedHeapBytes < 1024 * 1024, 'A bounded task retained its parent frame')
          } else {
            assert.ok(
              retainedHeapBytes > count * size * 0.75,
              'Baseline no longer reproduces retention'
            )
          }
          assert.ok(afterClearHeapBytes < 1024 * 1024, 'Tracker cleanup retained the fixture')
          results.push({
            count,
            size,
            ingress,
            retention,
            phase,
            visibleTextChars,
            retainedHeapBytes,
            afterClearHeapBytes
          })
        }
      }
    }
  }
  console.log(
    JSON.stringify({ node: process.version, platform: process.platform, bundles, results }, null, 2)
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
