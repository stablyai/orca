import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MONITOR_MAX_AGE_AT_ENABLE_MS,
  createDriver,
  parseDriverArguments
} from './drive-relay-director-deploy.mjs'
import {
  IMAGE_REPOSITORY,
  REPOSITORY,
  WORKFLOWS,
  blocksDeploy,
  parseConfigureWave,
  pausedGeneration,
  rehomeResultFromLog,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'
import { RELAY_WORKFLOW_FILE_PREFIX, relayWorkflowPath } from './relay-repository.mjs'

const COMMIT = 'a'.repeat(40)
const OLD = `sha256:${'1'.repeat(64)}`
const NEW = `sha256:${'2'.repeat(64)}`
const CELL = `sha256:${'3'.repeat(64)}`
const START = Date.parse('2026-10-05T04:50:00Z')
const MEMBERSHIP = {
  existingOnly: ['production-gce-c1'],
  migrationOnly: ['production-gce-c34'],
  general: ['production-gce-c27', 'production-gce-c7']
}
const CONTROL = {
  generation: 39,
  enabled: true,
  observationStartedAt: 1_786_687_676_179,
  notBefore: 1_790_934_023_000,
  ratePerMinute: 10,
  preferenceMaxAgeMs: 86_400_000,
  hostCooldownMs: 604_800_000,
  drainGraceMs: 3_600_000
}

function controlLine(mode, control, extra = {}) {
  const result = { event: 'relay_regional_rehome_control', mode, ...extra, control }
  return `operate / control\tUNKNOWN STEP\t2026-10-05T04:51:27Z ${JSON.stringify(result)}`
}

function monitorFiles(run, now, overrides = {}) {
  const incidentId = `relay-${run.id}-dry-run`
  const at = (offset) => new Date(now - offset).toISOString()
  const state = JSON.stringify({
    schemaVersion: 4,
    incidentId,
    environment: 'production',
    preDrainDryRun: true,
    migrationPolicy: 'strict',
    recoverySourceCellId: null,
    capacityCellId: null,
    durationMinutes: 15,
    intervalMs: 60_000,
    sampleCount: 16,
    frozenAt: null,
    failures: [],
    startedAt: at(16 * 60_000),
    windowStartedAt: at(15 * 60_000),
    lastSampleAt: at(0),
    completedAt: at(0),
    ...overrides
  })
  const manifest = {
    schemaVersion: 1,
    incidentId,
    runId: String(run.id),
    runAttempt: 1,
    commitSha: run.headSha,
    mode: 'dry-run',
    files: { [`${incidentId}.state.json`]: createHash('sha256').update(state).digest('hex') }
  }
  return {
    [`${incidentId}.state.json`]: state,
    'evidence-manifest.json': JSON.stringify(manifest)
  }
}

// A model of GitHub Actions and Cloud Run: each dispatch does what the real workflow would do to
// `world`, including the side effects a failing run leaves behind.
function fakeWorld(overrides = {}) {
  const world = {
    now: START,
    main: COMMIT,
    nextRunId: 37_000_000_000,
    runs: [],
    active: [],
    printUrl: true,
    revision: 700,
    serving: { revision: 'orca-cloud-relay-00700-qor', digest: OLD, createdAt: START - 86_400_000 },
    rollback: { revision: 'orca-cloud-relay-00699-das', digest: OLD },
    cells: ['production-gce-c1'],
    registry: {},
    selector: { generation: 345, attemptId: 'x', membership: MEMBERSHIP },
    control: CONTROL,
    publishedDigest: NEW,
    pushLogDigest: undefined,
    fail: {},
    monitorState: {},
    director5xx: () => 10,
    prompts: [],
    answer: (question) => question.match(/^Type (\S+(?: [0-9a-f]{12})?) to continue/)[1],
    printed: [],
    ...overrides
  }
  // The last rehome run before this deploy, where the driver finds the current generation.
  world.runs.push({
    id: 1,
    file: WORKFLOWS.rehome.file,
    conclusion: 'success',
    log: controlLine('enable', world.control)
  })
  world.dispatches = () => world.runs.filter((run) => run.dispatched)
  return world
}

function promote(world, digest) {
  world.revision += 5
  world.rollback = { revision: `orca-cloud-relay-00${world.revision - 1}-rbk`, digest }
  world.serving = {
    revision: `orca-cloud-relay-00${world.revision}-new`,
    digest,
    createdAt: world.now
  }
}

const nextGeneration = (world, enabled, step = 1) => {
  world.control = { ...world.control, generation: world.control.generation + step, enabled }
}

function simulate(world, run) {
  const { inputs } = run
  const failure = world.fail[run.key]
  delete world.fail[run.key]
  run.conclusion = failure ? 'failure' : 'success'
  if (failure === 'before-apply') return
  if (run.file === WORKFLOWS.admission.file && inputs.mode === 'inspect') {
    const result = {
      v: 1,
      mode: 'inspect',
      generation: world.selector.generation,
      membership: world.selector.membership
    }
    run.artifacts[`relay-asia-admission-result-${run.id}-1`] = {
      'result.json': JSON.stringify(result)
    }
  } else if (run.file === WORKFLOWS.admission.file) {
    assert.equal(inputs.confirmation, 'CONFIGURE_ASIA_DIRECTOR')
    promote(world, inputs['director-image-digest'])
    world.cells = [...world.cells, ...inputs['cell-ids'].split(',')]
  } else if (run.file === WORKFLOWS.rehome.file) {
    const identities =
      inputs['director-image-digest'] === world.serving.digest &&
      inputs['rollback-image-digest'] === world.rollback.digest
    const matches =
      Number(inputs['expected-control-generation']) === world.control.generation &&
      Number(inputs['expected-selector-generation']) === world.selector.generation
    if (inputs.mode === 'pause' && matches && world.control.enabled) {
      assert.equal(inputs.confirmation, 'PAUSE_REGIONAL_REHOMING')
      // The real job applies the pause before anything else can fail.
      nextGeneration(world, false)
      run.log = controlLine('pause', world.control)
    } else if (inputs.mode === 'enable') {
      assert.equal(inputs.confirmation, 'ENABLE_REGIONAL_REHOMING')
      assert.equal(
        world.runs.find((other) => other.id === Number(inputs['monitor-run-id']))?.file,
        WORKFLOWS.monitor.file
      )
      if (matches && identities && !failure) {
        nextGeneration(world, true)
        run.log = controlLine('enable', world.control)
        return
      }
      run.conclusion = 'failure'
      if (failure === 'applied-silent') {
        // Applied, then a later step failed and the recovery printed nothing.
        nextGeneration(world, true)
        run.log = controlLine('enable', world.control)
        return
      }
      // Applied, then the job's own recovery disabled it again; or a director safety pause got
      // there first and recovery found it disabled.
      if (failure === 'applied-then-recovered') nextGeneration(world, false, 2)
      if (failure === 'safety-pause') nextGeneration(world, false, 3)
      run.log = controlLine('recover-enable', world.control, {
        recovered: failure === 'applied-then-recovered'
      })
    } else if (!matches || (inputs.mode === 'inspect' && !identities)) {
      run.conclusion = 'failure'
    } else {
      run.log = controlLine(inputs.mode, world.control)
    }
  } else if (run.file === WORKFLOWS.publish.file) {
    world.registry[`${IMAGE_REPOSITORY}:sha-${run.headSha}`] = world.publishedDigest
    run.log = `publish\tBuild\tsha-${run.headSha}: digest: ${world.pushLogDigest ?? world.publishedDigest} size: 3241`
  } else if (run.file === WORKFLOWS.director.file) {
    if (
      world.control.enabled ||
      Number(inputs['expected-rehome-generation']) !== world.control.generation
    ) {
      run.conclusion = 'failure'
      return
    }
    promote(world, inputs['image-digest'])
    // Blue/green takes minutes; traffic moves about one before the run completes.
    world.now += 4 * 60_000
  } else if (run.file === WORKFLOWS.monitor.file) {
    world.now += 16 * 60_000
    run.artifacts[`relay-monitor-dry-run-${run.id}-1`] = monitorFiles(
      run,
      world.now,
      world.monitorState
    )
  }
}

function flag(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function gh(world, args, input) {
  const ok = (value) => ({
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ''
  })
  if (args[0] === 'api' && args[1] === 'user') return ok('operator\n')
  if (args[0] === 'api' && args.includes('--paginate')) {
    const status = flag(args, '-f').slice('status='.length)
    return ok(
      world.active
        .filter((run) => run.status === status)
        .map((run) => `${JSON.stringify(run)}\n`)
        .join('')
    )
  }
  if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
    const claimed = world.runs.find(
      (candidate) => candidate.id === Number(args[1].split('/').at(-1))
    )
    return ok({
      path: relayWorkflowPath(claimed.file.slice(RELAY_WORKFLOW_FILE_PREFIX.length)),
      actor: claimed.actor ?? 'operator'
    })
  }
  if (args[0] === 'api') return ok(`${world.main}\n`)
  if (args[0] === 'workflow') {
    const workflow = Object.values(WORKFLOWS).find((candidate) => candidate.file === args[2])
    const inputs = JSON.parse(input)
    const run = {
      id: world.nextRunId++,
      file: workflow.file,
      name: workflow.name,
      inputs,
      key: `${workflow.file}:${inputs.mode ?? 'deploy'}`,
      dispatched: true,
      headSha: world.main,
      polls: world.polls?.[`${workflow.file}:${inputs.mode ?? 'deploy'}`] ?? 0,
      artifacts: {},
      log: ''
    }
    world.runs.push(run)
    simulate(world, run)
    return ok(
      world.printUrl ? `https://github.com/${REPOSITORY}/actions/runs/${run.id}\n` : 'Created\n'
    )
  }
  const run = world.runs.find((candidate) => candidate.id === Number(args[2]))
  if (args[1] === 'list') {
    const runs = world.runs
      .filter((candidate) => candidate.file === flag(args, '--workflow'))
      .reverse()
    return ok(runs.map((candidate) => ({ databaseId: candidate.id })))
  }
  if (args[1] === 'view' && args.includes('--log')) {
    return world.unreadableLogs?.(run) ? { status: 1, stdout: '', stderr: 'HTTP 502' } : ok(run.log)
  }
  if (args[1] === 'view') {
    world.onView?.(run)
    const running = run.polls > 0
    if (running) run.polls -= 1
    return ok({
      status: running ? 'in_progress' : 'completed',
      conclusion: running ? '' : run.conclusion,
      attempt: 1,
      headSha: run.headSha,
      headBranch: 'main',
      event: 'workflow_dispatch',
      workflowName: run.name
    })
  }
  if (args[1] === 'download') {
    const files = run.artifacts[flag(args, '-n')]
    if (!files) return { status: 1, stdout: '', stderr: 'no artifact' }
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(flag(args, '-D'), name), content)
    return ok('')
  }
  throw new Error(`unexpected gh ${args.join(' ')}`)
}

function gcloud(world, args) {
  const ok = (value) => ({
    status: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: ''
  })
  if (args[1] === 'services') {
    return ok({
      status: {
        traffic: [
          { revisionName: world.serving.revision, percent: 100 },
          { revisionName: world.rollback.revision, percent: 0, tag: 'selector-rollback' }
        ]
      }
    })
  }
  if (args[1] === 'revisions') {
    const revision = [world.serving, world.rollback].find(
      (candidate) => candidate.revision === args[3]
    )
    const cells = JSON.stringify(world.cells.map((id) => ({ id })))
    return ok({
      metadata: { creationTimestamp: new Date(revision.createdAt ?? START).toISOString() },
      spec: {
        containers: [
          {
            image: `${IMAGE_REPOSITORY}@${revision.digest}`,
            env: [{ name: 'ORCA_RELAY_CELLS_JSON', value: cells }]
          }
        ]
      }
    })
  }
  if (args[0] === 'artifacts') return ok(`${world.registry[args[4]] ?? ''}\n`)
  if (args[0] === 'logging') {
    const [, from, to] = args[2].match(/timestamp>="([^"]+)" AND timestamp<"([^"]+)"/)
    world.reads = [
      ...(world.reads ?? []),
      { from: Date.parse(from), to: Date.parse(to), readAt: world.now }
    ]
    return ok('t\n'.repeat(world.director5xx(Date.parse(from), Date.parse(to))))
  }
  throw new Error(`unexpected gcloud ${args.join(' ')}`)
}

function dependencies(world) {
  return {
    run: (program, args, input) =>
      program === 'gh' ? gh(world, args, input) : gcloud(world, args),
    now: () => world.now,
    sleep: async (ms) => {
      world.now += ms
    },
    print: (line) => {
      // Every command the driver prints must be one its own parser accepts.
      for (const [, argv] of line.matchAll(/drive-relay-director-deploy\.mjs ([^*]+?)\s*$/g)) {
        assert.doesNotThrow(() => parseDriverArguments(argv.split(' ')), line)
      }
      world.printed.push(line)
    },
    prompt: async (question) => {
      world.questions = [...(world.questions ?? []), question]
      const answer = world.answer(question)
      world.prompts.push(question.match(/^Type (\S+(?: [0-9a-f]{12})?) to continue/)[1])
      return answer
    }
  }
}

const logDirectory = () => mkdtempSync(join(tmpdir(), 'relay-deploy-test-'))

function drive(world, argv, deps = dependencies(world)) {
  return createDriver(
    parseDriverArguments([...argv, '--log-directory', logDirectory()]),
    deps
  ).run()
}

const start = (world, extra = [], deps) => drive(world, ['--commit', COMMIT, ...extra], deps)

// Runs the last printed command, or the last one on a line containing `marker`.
function rerun(world, marker = '') {
  const command = world.printed
    .filter((line) => line.includes(marker) && line.includes('drive-relay-director-deploy.mjs '))
    .at(-1)
  const argv = command
    .slice(command.indexOf('.mjs ') + 5)
    .trim()
    .split(' ')
  world.printed.length = 0
  return drive(world, argv)
}

const stopped = (promise) =>
  promise.then(
    () => assert.fail('expected the driver to stop'),
    (error) => error
  )

function keys(world) {
  return world
    .dispatches()
    .map((run) => run.key.slice(RELAY_WORKFLOW_FILE_PREFIX.length).replace('.yml', ''))
}

const dispatched = (world, key) => world.dispatches().filter((run) => run.key === key)
const REHOME = (mode) => `${WORKFLOWS.rehome.file}:${mode}`
const DEPLOY = `${WORKFLOWS.director.file}:deploy`
const PUBLISH = `${WORKFLOWS.publish.file}:publish`
const MONITOR = `${WORKFLOWS.monitor.file}:dry-run`
const report = (world) => world.printed.join('\n')
const live = (world) => [world.control.generation, world.control.enabled]

test('publishes first, types every phrase, and enables on the digests now serving', async () => {
  const world = fakeWorld()
  assert.equal((await start(world)).done, true)
  assert.deepEqual(keys(world), [
    'publish-relay-production:publish',
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect',
    'operate-relay-production-rehome:pause',
    'deploy-relay-production-director:deploy',
    'operate-relay-production-rehome:inspect',
    'monitor-relay-production:dry-run',
    'operate-relay-production-rehome:enable'
  ])
  assert.deepEqual(world.prompts, [
    'DEPLOY aaaaaaaaaaaa',
    'PAUSE_REGIONAL_REHOMING',
    'ENABLE_REGIONAL_REHOMING'
  ])
  assert.ok(world.questions.every((question) => question.endsWith('\n')))
  assert.ok(
    world.questions.some((question) =>
      question.includes(
        'arms an automatic enable, sent about 17 min from now and only if the monitor is green and its evidence is at most 150 s old'
      )
    )
  )
  const [deploy] = dispatched(world, DEPLOY)
  assert.deepEqual(
    [
      deploy.inputs['image-digest'],
      deploy.inputs['predecessor-image-digest'],
      deploy.inputs['expected-rehome-generation']
    ],
    [NEW, OLD, '40']
  )
  const [enable] = dispatched(world, REHOME('enable'))
  const [monitor] = dispatched(world, MONITOR)
  assert.deepEqual(
    [
      enable.inputs['director-image-digest'],
      enable.inputs['rollback-image-digest'],
      enable.inputs['expected-control-generation'],
      enable.inputs['monitor-run-id']
    ],
    [NEW, NEW, '40', String(monitor.id)]
  )
  assert.equal(monitor.inputs['expected-general-cells'], 'production-gce-c27,production-gce-c7')
  assert.deepEqual(live(world), [41, true])
})

test('a wrong phrase stops before rehome or the director is touched', async () => {
  const world = fakeWorld({ answer: () => 'yes' })
  assert.match((await stopped(start(world))).message, /expected DEPLOY aaaaaaaaaaaa/)
  assert.deepEqual(keys(world), [
    'publish-relay-production:publish',
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect'
  ])
})

test('F2: rehome found paused is never adopted; --leave-rehome-paused deploys and leaves it paused', async () => {
  const world = fakeWorld({ control: { ...CONTROL, generation: 52, enabled: false } })
  assert.match(
    (await stopped(start(world))).message,
    /did not pause it.*--pause-run.*--leave-rehome-paused/s
  )
  assert.match(report(world), /drive-relay-director-deploy\.mjs .*--publish-run \d+/)
  await rerun(world).catch(() => {})
  assert.equal(dispatched(world, PUBLISH).length, 1)
  await start(world, ['--leave-rehome-paused'])
  assert.equal(
    dispatched(world, REHOME('pause')).length + dispatched(world, REHOME('enable')).length,
    0
  )
  assert.equal(dispatched(world, DEPLOY)[0].inputs['expected-rehome-generation'], '52')
  assert.deepEqual(live(world), [52, false])
})

test('F2: main moving is caught before any rehome change, and after the pause it changes nothing', async () => {
  const moved = fakeWorld({ main: 'b'.repeat(40) })
  assert.match((await stopped(start(moved))).message, /not the reviewed/)
  assert.equal(moved.dispatches().length, 0)

  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'pause') world.main = 'b'.repeat(40)
    return result
  }
  assert.equal((await start(world, [], deps)).done, true)
  assert.deepEqual(live(world), [41, true])
})

test('ops-log 22:59Z: main moving during the inspects and the typed phrase no longer stops the deploy', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'inspect') world.main = 'b'.repeat(40)
    return result
  }
  assert.equal((await start(world, [], deps)).done, true)
  assert.equal(dispatched(world, PUBLISH)[0].headSha, COMMIT)
  assert.equal(dispatched(world, DEPLOY)[0].inputs['image-digest'], NEW)
})

test('main moving between the check and the publish stops untouched, naming the reuse command', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    if (args[0] === 'workflow') world.main = 'b'.repeat(40)
    return run(program, args, input)
  }
  assert.match((await stopped(start(world, [], deps))).message, /main moved/)
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.deepEqual(keys(world), ['publish-relay-production:publish'])
  // The only command printed is the one that reuses the build.
  const commands = world.printed.filter((line) => line.includes('&& node dev/scripts/'))
  assert.equal(commands.length, 1)
  assert.match(commands[0], new RegExp(`--commit ${world.main} --publish-run ${publishRun}$`))
  assert.equal((await rerun(world)).done, true)
  assert.equal(dispatched(world, PUBLISH).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('a running workflow is summarised, not streamed', async () => {
  const world = fakeWorld({ polls: { [PUBLISH]: 40 } })
  assert.equal((await start(world)).done, true)
  assert.deepEqual(
    world.printed
      .filter((line) => / publish: (in_progress|success)/.test(line))
      .map((line) => line.slice(25)),
    [
      'publish: in_progress, 0 min',
      'publish: in_progress, 5 min',
      `publish: success https://github.com/${REPOSITORY}/actions/runs/${dispatched(world, PUBLISH)[0].id}`
    ]
  )
})

test('a publish whose log disagrees with the registry stops before rehome is touched', async () => {
  const world = fakeWorld({ pushLogDigest: CELL })
  assert.match((await stopped(start(world))).message, /tag moved/)
  assert.equal(dispatched(world, REHOME('pause')).length, 0)
  assert.match(report(world), /rehome: not read; this run did not change it/)
})

test('dry run dispatches nothing and prints every step', async () => {
  const world = fakeWorld()
  const directory = logDirectory()
  await createDriver(
    parseDriverArguments([
      '--commit',
      COMMIT,
      '--dry-run',
      '--configure',
      `production-gce-c34=${CELL}`,
      '--log-directory',
      directory
    ]),
    dependencies(world)
  ).run()
  assert.equal(world.dispatches().length, 0)
  assert.equal(world.prompts.length, 0)
  const plan = world.printed.filter((line) => line.includes(' plan '))
  assert.equal(plan.length, 10)
  assert.ok(plan.some((line) => line.includes('"expected-control-generation":"39"')))
  assert.ok(
    plan.some((line) => line.includes('"confirmation":"<operator types CONFIGURE_ASIA_DIRECTOR>"'))
  )
  assert.deepEqual(
    readdirSync(directory).map((name) => name.endsWith('-dry-run.log')),
    [true]
  )
})

test('an in-flight relay workflow stops the preflight; no printed run URL stops the dispatch', async () => {
  const busy = fakeWorld({
    active: [
      {
        id: 9,
        path: relayWorkflowPath('deploy-relay-production-same-cap.yml'),
        name: 'Same cap',
        status: 'waiting'
      }
    ]
  })
  assert.match((await stopped(start(busy))).message, /in flight/)
  assert.equal(busy.dispatches().length, 0)
  const silent = fakeWorld({ printUrl: false })
  assert.match((await stopped(start(silent))).message, /printed no run URL/)
})

test('F1: an interrupt while the pause is in flight says rehome is changing, and the printed command finishes', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  let driver
  world.onView = () => {
    if (world.dispatches().at(-1)?.inputs.mode === 'pause' && !world.interrupted) {
      world.interrupted = true
      driver.interrupt('SIGINT')
      throw new Error('killed')
    }
  }
  driver = createDriver(
    parseDriverArguments(['--commit', COMMIT, '--log-directory', logDirectory()]),
    deps
  )
  await driver.run().catch(() => {})
  assert.match(
    report(world),
    /STOPPED: interrupted by SIGINT[\s\S]*REHOME IS CHANGING: the pause run .* applies on its own/
  )
  assert.match(report(world), /finish with: cd cloud && .* --publish-run \d+ --pause-run \d+/)
  assert.equal(await rerun(world).then((result) => result.done), true)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.equal(dispatched(world, PUBLISH).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('F1: an interrupt while the enable is in flight never says rehome is paused', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  let driver
  world.onView = () => {
    if (world.dispatches().at(-1)?.inputs.mode === 'enable') driver.interrupt('SIGTERM')
  }
  driver = createDriver(
    parseDriverArguments(['--commit', COMMIT, '--log-directory', logDirectory()]),
    deps
  )
  await driver.run()
  const text = report(world)
  assert.match(
    text,
    /REHOME IS CHANGING: the enable run .* it enables rehome, or disables it again if it fails/
  )
  assert.doesNotMatch(text.slice(text.indexOf('interrupted')), /REHOME IS PAUSED/)
})

test('a pause run that printed nothing is PAUSE UNCONFIRMED, and a later safety pause is never lifted', async () => {
  const world = fakeWorld({ fail: { [REHOME('pause')]: 'before-apply' } })
  await stopped(start(world))
  assert.match(report(world), /PAUSE UNCONFIRMED: .* printed no pause. Rehome MAY BE PAUSED/)
  // A director safety pause lands; the operator follows the report's command.
  nextGeneration(world, false)
  assert.match((await stopped(rerun(world))).message, /printed no pause of its own/)
  assert.equal(dispatched(world, REHOME('enable')).length, 0)
})

test('a failed deploy leaves its pause owned, and the printed command finishes without pausing or publishing again', async () => {
  const world = fakeWorld({ fail: { [DEPLOY]: 'before-apply' } })
  await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  assert.match(report(world), /rollback point: orca-cloud-relay-00700-qor/)
  await rerun(world)
  assert.equal(dispatched(world, REHOME('pause')).length, 1)
  assert.equal(dispatched(world, PUBLISH).length, 1)
  assert.equal(dispatched(world, DEPLOY).length, 2)
  assert.deepEqual(live(world), [41, true])
})

test('a frozen monitor stops with its failures; the re-run runs a fresh one', async () => {
  const failures = [
    { source: 'auth', code: 'threshold_equal', signal: 'health', observed: 0, threshold: 1 }
  ]
  const world = fakeWorld({ monitorState: { frozenAt: '2026-10-05T05:30:00Z', failures } })
  assert.match(
    (await stopped(start(world))).message,
    /incomplete or stale[\s\S]*auth threshold_equal health 0 1/
  )
  world.monitorState = {}
  await rerun(world)
  assert.equal(dispatched(world, MONITOR).length, 2)
  assert.equal(dispatched(world, DEPLOY).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('stale monitor evidence is not spent on an enable', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const prompt = deps.prompt
  deps.prompt = async (question) => {
    const answer = await prompt(question)
    if (answer === 'ENABLE_REGIONAL_REHOMING') {
      const completed = world.now + 16 * 60_000 - MONITOR_MAX_AGE_AT_ENABLE_MS - 1000
      const at = (offset) => new Date(completed - offset).toISOString()
      world.monitorState = {
        completedAt: at(0),
        lastSampleAt: at(0),
        windowStartedAt: at(15 * 60_000),
        startedAt: at(16 * 60_000)
      }
    }
    return answer
  }
  assert.match((await stopped(start(world, [], deps))).message, /past the 150 s budget/)
  assert.equal(dispatched(world, REHOME('enable')).length, 0)
})

test('the ops-log 05:41Z case: an enable that failed before applying is finished by the printed command', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'not-applied' } })
  await stopped(start(world))
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  await rerun(world)
  assert.deepEqual(live(world), [41, true])
})

test('an enable whose own recovery paused rehome again hands ownership to that run', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'applied-then-recovered' } })
  await stopped(start(world))
  const [enable] = dispatched(world, REHOME('enable'))
  assert.match(
    report(world),
    new RegExp(`REHOME IS PAUSED by this driver at generation 42 \\(.*${enable.id}\\)`)
  )
  await rerun(world)
  assert.deepEqual(live(world), [43, true])
})

test('F3: a director safety pause found by the enable recovery is never adopted or lifted', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'safety-pause' } })
  await stopped(start(world))
  assert.match(report(world), /rehome: generation 43 as last read, PAUSED, not by this driver/)
  const stop = report(world).slice(report(world).indexOf('STOPPED'))
  assert.doesNotMatch(stop, /--pause-run/)
  assert.match((await stopped(rerun(world))).message, /did not pause it/)
  const [pause] = dispatched(world, REHOME('pause'))
  const claim = await stopped(
    drive(world, [
      '--commit',
      COMMIT,
      '--publish-run',
      String(dispatched(world, PUBLISH)[0].id),
      '--pause-run',
      String(pause.id)
    ])
  )
  assert.match(claim.message, /not the pause .* made at 40/)
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
  assert.deepEqual(live(world), [43, false])
})

test('P1: a green enable with an unreadable log is ENABLE UNCONFIRMED, and the printed command settles it', async () => {
  const world = fakeWorld({ unreadableLogs: (run) => run.inputs?.mode === 'enable' })
  await stopped(start(world))
  assert.match(
    report(world),
    /ENABLE UNCONFIRMED: .* did not confirm the enable. Rehome may be enabled, or paused/
  )
  world.unreadableLogs = undefined
  assert.equal((await rerun(world, 'If it enabled rehome')).done, true)
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
  assert.deepEqual(live(world), [41, true])
})

test('configure waits out a soak anchored at the traffic switch, then takes a typed phrase', async () => {
  const world = fakeWorld()
  await start(world, ['--configure', `production-gce-c34=${CELL}`])
  const [configure] = dispatched(world, `${WORKFLOWS.admission.file}:configure`)
  assert.deepEqual(
    [
      configure.inputs['cell-ids'],
      configure.inputs['image-digest'],
      configure.inputs['director-image-digest'],
      configure.inputs['selector-generation']
    ],
    ['production-gce-c34', CELL, NEW, '345']
  )
  assert.ok(world.prompts.includes('CONFIGURE_ASIA_DIRECTOR'))
  const [before, after] = world.reads
  assert.equal(after.to - after.from, 5 * 60_000)
  // The deploy ran 4 minutes; traffic moved a minute before it completed.
  assert.equal(after.from, START + 3 * 60_000)
  assert.equal(before.to, START)
  assert.ok(after.readAt >= after.to + 60_000)
})

test('F5: a tripped soak is judged again on fresh traffic by the printed command', async () => {
  const world = fakeWorld({ director5xx: (from) => (from >= START ? 200 : 10) })
  assert.match(
    (await stopped(start(world, ['--configure', `production-gce-c34=${CELL}`]))).message,
    /5xx rose from 10 to 200/
  )
  assert.match(report(world), /REHOME IS PAUSED by this driver at generation 40/)
  world.director5xx = () => 10
  world.now += 30 * 60_000
  const rerunAt = world.now
  await rerun(world)
  assert.equal(dispatched(world, `${WORKFLOWS.admission.file}:configure`).length, 1)
  assert.ok(world.reads.at(-1).from >= rerunAt)
  assert.deepEqual(live(world), [41, true])
})

test('P8 and G1: the printed command never reports DONE without reading rehome', async () => {
  const world = fakeWorld()
  await start(world)
  const before = world.dispatches().length
  world.prompts.length = 0
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.equal((await drive(world, ['--commit', COMMIT, '--publish-run', publishRun])).done, true)
  assert.deepEqual(keys(world).slice(before), [
    'operate-relay-asia-admission:inspect',
    'operate-relay-production-rehome:inspect'
  ])
  assert.equal(world.prompts.length, 0)
  assert.match(report(world), /DONE: .* rehome enabled/)

  // G1: the deploy is done but the driver's pause still holds; dropping --pause-run must not hide it.
  const paused = fakeWorld({ monitorState: { frozenAt: '2026-10-05T05:30:00Z' } })
  await stopped(start(paused))
  const run = String(dispatched(paused, PUBLISH)[0].id)
  assert.match(
    (await stopped(drive(paused, ['--commit', COMMIT, '--publish-run', run]))).message,
    /did not pause it/
  )
  assert.deepEqual(live(paused), [40, false])
})

test("G2: --pause-run accepts only this operator's own rehome-control run", async () => {
  const world = fakeWorld({ control: { ...CONTROL, generation: 40, enabled: false } })
  // Another operator paused rehome by hand.
  world.runs.push({
    id: 900,
    file: WORKFLOWS.rehome.file,
    actor: 'someone-else',
    conclusion: 'success',
    log: controlLine('pause', world.control)
  })
  assert.match(
    (await stopped(start(world, ['--pause-run', '900']))).message,
    /is not a .* run by operator/
  )
  // A run of another workflow cannot prove a pause either.
  world.runs.push({
    id: 901,
    file: WORKFLOWS.monitor.file,
    conclusion: 'success',
    log: controlLine('pause', world.control)
  })
  assert.match(
    (await stopped(start(world, ['--pause-run', '901']))).message,
    /is not a .* run by operator/
  )
  assert.equal(world.dispatches().length, 0)
  assert.deepEqual(live(world), [40, false])
})

test('G3: a failed enable run is never reported RE-ENABLED, whatever it printed last', async () => {
  const world = fakeWorld({ fail: { [REHOME('enable')]: 'applied-silent' } })
  await stopped(start(world))
  assert.doesNotMatch(report(world), /RE-ENABLED|DONE/)
  assert.match(report(world), /ENABLE UNCONFIRMED: .* did not confirm the enable/)
  // The printed command re-reads live state: rehome is at the pause's generation + 1, enabled.
  const pauseRun = String(dispatched(world, REHOME('pause'))[0].id)
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.equal(
    (await drive(world, ['--commit', COMMIT, '--publish-run', publishRun, '--pause-run', pauseRun]))
      .done,
    true
  )
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
})

test('Q1 and C1: after a hard kill mid-pause, the re-run names the pause its log recorded and finishes with it', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const directory = logDirectory()
  let logAtKill
  world.onView = () => {
    if (world.dispatches().at(-1)?.key !== REHOME('pause')) return
    // SIGKILL writes no stop report: only what was logged before the watch survives.
    logAtKill = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')
    world.onView = undefined
    throw new Error('SIGKILL')
  }
  await stopped(
    createDriver(
      parseDriverArguments(['--commit', COMMIT, '--log-directory', directory]),
      deps
    ).run()
  )
  world.printed.length = 0
  const [pause] = dispatched(world, REHOME('pause'))
  assert.match(logAtKill, new RegExp(`runs/${pause.id}`))
  const publishRun = String(dispatched(world, PUBLISH)[0].id)
  assert.match(
    (await stopped(drive(world, ['--commit', COMMIT, '--publish-run', publishRun]))).message,
    /did not pause it.*--pause-run its log printed/
  )
  assert.deepEqual(live(world), [40, false])
  const argv = ['--commit', COMMIT, '--publish-run', publishRun, '--pause-run', String(pause.id)]
  assert.equal((await drive(world, argv)).done, true)
  assert.deepEqual(live(world), [41, true])
})

test('Q5: a failed enable followed by an unexplained disable is never adopted', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'enable') {
      world.runs.at(-1).conclusion = 'failure'
      world.control = { ...world.control, generation: 42, enabled: false }
    }
    return result
  }
  await stopped(start(world, [], deps))
  assert.match(report(world), /ENABLE UNCONFIRMED/)
  assert.doesNotMatch(report(world), /RE-ENABLED|DONE/)
  const commands = ['failed before applying', 'paused rehome again'].map((marker) => {
    const line = world.printed.findLast((printed) => printed.includes(marker))
    return line.slice(line.indexOf('.mjs ') + 5).split(' ')
  })
  for (const argv of commands) {
    assert.match((await stopped(drive(world, argv))).message, /--rehome-generation|cannot prove/)
    const pinned = await stopped(drive(world, [...argv, '--rehome-generation', '42']))
    assert.match(pinned.message, /not the pause|cannot prove/)
  }
  assert.equal(dispatched(world, REHOME('enable')).length, 1)
  assert.deepEqual(live(world), [42, false])
})

test('C1: a pause whose run cannot be viewed, or printed no URL, is reported as REHOME IS CHANGING', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const pause = dispatched(world, REHOME('pause'))[0]
    if (pause && args[1] === 'view' && args[2] === String(pause.id) && args.includes('--json')) {
      return { status: 1, stdout: '', stderr: 'HTTP 502' }
    }
    return run(program, args, input)
  }
  await stopped(start(world, [], deps))
  const [pause] = dispatched(world, REHOME('pause'))
  assert.match(report(world), new RegExp(`REHOME IS CHANGING: the pause run .*${pause.id}`))
  assert.match(report(world), new RegExp(`finish with: cd cloud && .*--pause-run ${pause.id}`))
  assert.doesNotMatch(report(world), /Re-run to finish/)

  const silent = fakeWorld()
  const silentDeps = dependencies(silent)
  const silentRun = silentDeps.run
  silentDeps.run = (program, args, input) => {
    const result = silentRun(program, args, input)
    return args[0] === 'workflow' && JSON.parse(input).mode === 'pause'
      ? { ...result, stdout: 'Created\n' }
      : result
  }
  await stopped(start(silent, [], silentDeps))
  assert.match(
    report(silent),
    /REHOME IS CHANGING: the pause run \(gh printed no URL; find it at https:/
  )
  assert.doesNotMatch(report(silent), /Re-run to finish/)
})

test('C2: --leave-rehome-paused refuses an enabled switch instead of pausing it', async () => {
  const world = fakeWorld()
  assert.match(
    (await stopped(start(world, ['--leave-rehome-paused']))).message,
    /accepts only a paused switch/
  )
  assert.equal(dispatched(world, REHOME('pause')).length, 0)
})

test('G4: an interrupt during the enable prints both commands that can finish', async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  let driver
  world.onView = () => {
    if (world.dispatches().at(-1)?.inputs.mode === 'enable') driver.interrupt('SIGINT')
  }
  driver = createDriver(
    parseDriverArguments(['--commit', COMMIT, '--log-directory', logDirectory()]),
    deps
  )
  await driver.run()
  const [pause] = dispatched(world, REHOME('pause'))
  const [enable] = dispatched(world, REHOME('enable'))
  assert.match(
    report(world),
    new RegExp(
      `If it enabled rehome, or failed before applying, finish with: cd cloud && .*--pause-run ${pause.id}`
    )
  )
  assert.match(
    report(world),
    new RegExp(
      `If its recovery paused rehome again, finish with: cd cloud && .*--pause-run ${enable.id}`
    )
  )
})

test("G5: the driver's own run, still listed as in progress, does not block its next step", async () => {
  const world = fakeWorld()
  const deps = dependencies(world)
  const run = deps.run
  deps.run = (program, args, input) => {
    const result = run(program, args, input)
    if (args[0] === 'workflow' && JSON.parse(input).mode === 'dry-run') {
      const monitor = world.runs.at(-1)
      world.active.push({
        id: monitor.id,
        path: relayWorkflowPath('monitor-relay-production.yml'),
        name: 'Monitor',
        status: 'in_progress'
      })
    }
    return result
  }
  assert.equal((await start(world, [], deps)).done, true)
  assert.deepEqual(live(world), [41, true])
})

test('argument parsing and plan helpers fail closed', () => {
  assert.throws(() => parseDriverArguments([]), /missing --commit/)
  assert.throws(() => parseDriverArguments(['--commit', 'abc']), /full commit SHA/)
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--pause-run', 'x']),
    /must be a run ID/
  )
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--pause-run', '5', '--leave-rehome-paused']),
    /contradict/
  )
  assert.throws(
    () => parseDriverArguments(['--commit', COMMIT, '--configure', 'production-gce-c34']),
    /--configure must be/
  )
  assert.deepEqual(parseConfigureWave(`production-gce-c27,production-gce-c28=${CELL}`).cells, [
    'production-gce-c27',
    'production-gce-c28'
  ])
  assert.throws(
    () => validateDispatchInputs({ confirmation: '<operator types X>' }),
    /not resolved/
  )
  assert.throws(
    () => validateDispatchInputs({ 'image-digest': 'sha256:abc' }),
    /not a sha256 digest/
  )
  assert.ok(blocksDeploy(relayWorkflowPath('push-deploy.yml')))
  assert.ok(blocksDeploy(`${relayWorkflowPath('push-deploy.yml')}@refs/heads/main`))
  assert.ok(!blocksDeploy(relayWorkflowPath('monitor-relay-clock-skew.yml')))
  const disabled = { ...CONTROL, enabled: false }
  assert.equal(pausedGeneration(rehomeResultFromLog(controlLine('pause', disabled))), 39)
  assert.equal(
    pausedGeneration(
      rehomeResultFromLog(controlLine('recover-enable', disabled, { recovered: true }))
    ),
    39
  )
  assert.equal(
    pausedGeneration(
      rehomeResultFromLog(controlLine('recover-enable', disabled, { recovered: false }))
    ),
    undefined
  )
  assert.equal(pausedGeneration(rehomeResultFromLog(controlLine('inspect', disabled))), undefined)
  assert.throws(() => rehomeResultFromLog('nothing'), /printed no control/)
})
