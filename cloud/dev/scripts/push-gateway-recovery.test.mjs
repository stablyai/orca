import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { readRelayWorkflow } from './relay-repository.mjs'

const workflow = readRelayWorkflow('push-deploy.yml')
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.notEqual(start, -1)
  const end = workflow.indexOf('\n      - ', start + 1)
  const block = workflow.slice(start, end === -1 ? undefined : end)
  return block
    .slice(block.indexOf('        run: |\n') + '        run: |\n'.length)
    .split('\n')
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n')
}
const names = {
  preflight: 'Record the serving revision and require its Terraform-owned scaling',
  candidate: 'Deploy the candidate revision with no traffic',
  activate: 'Retire inert validation and activate the verified image',
  shift: 'Shift all traffic to the verified candidate',
  public: 'Verify the public origin after the shift',
  rollback: 'Roll traffic back to the previous revision',
  restore: 'Restore the known-good service template',
  promoteRecovery: 'Promote and verify the known-good recovery revision',
  cleanup: 'Delete the rejected candidate revision',
  retire: 'Retire previous consumers after public checks'
}
const image = `registry/push@sha256:${'a'.repeat(64)}`
const spec = {
  serviceAccountName: 'runtime@test',
  containerConcurrency: 40,
  containers: [
    {
      image,
      name: 'push-test-1',
      env: [
        {
          name: 'ORCA_PUSH_DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'database', key: '7' } }
        },
        { name: 'ORCA_PUSH_DATABASE_POOL_MAX', value: '2' }
      ]
    }
  ]
}
const prior = {
  metadata: {
    name: 'push-test-old',
    annotations: {
      'autoscaling.knative.dev/minScale': '1',
      'autoscaling.knative.dev/maxScale': '2'
    }
  },
  spec,
  status: { imageDigest: image }
}
const model = fileURLToPath(new URL('./push-cloud-run-model.mjs', import.meta.url))
const options = { skip: process.platform === 'win32' }
function exercise(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'push-workflow-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(
    statePath,
    JSON.stringify({
      revisions: { 'push-test-old': prior },
      latest: 'push-test-old',
      serving: 'push-test-old',
      tags: {},
      peak: 1,
      trace: []
    })
  )
  writeFileSync(join(dir, 'env'), '')
  const env = {
    ...process.env,
    SERVICE_NAME: 'push-test',
    GCP_PROJECT_ID: 'test',
    GCP_REGION: 'test',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    IMAGE: `registry/push@sha256:${'b'.repeat(64)}`,
    PUSH_MIN_INSTANCES: '1',
    PUSH_MAX_INSTANCES: '2',
    PUSH_RUNTIME_SERVICE_ACCOUNT: 'runtime@test',
    PUSH_ORIGIN: 'https://public.test',
    MODEL_STATE: statePath,
    MODEL_SCRIPT: model,
    RUNNER_TEMP: dir,
    GITHUB_ENV: join(dir, 'env'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary')
  }
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const change = (edit) => {
    const value = state()
    edit(value)
    writeFileSync(statePath, JSON.stringify(value))
  }
  const run = (key, ok = true, extra = '') => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      set -a
      source "$GITHUB_ENV"
      gcloud() { node "$MODEL_SCRIPT" "$@"; }
      curl() { node "$MODEL_SCRIPT" curl "$@"; }
      sleep() { :; }
      ${extra}
      ${names[key] ? step(names[key]) : key}
    `
      ],
      { cwd: dir, env, encoding: 'utf8', timeout: 30000 }
    )
    assert.equal(result.status === 0, ok, `${key}: ${result.stderr}\n${result.stdout}`)
    return result
  }
  try {
    callback({ run, state, change, dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
function recover(h) {
  h.change((state) => {
    delete state.failure
  })
  h.run('restore')
  h.run('promoteRecovery')
  h.run('cleanup')
  h.run('retire')
  const state = h.state()
  assert.equal(state.serving, 'push-test-r123-1')
  assert.equal(state.latest, state.serving)
  assert.deepEqual(Object.keys(state.revisions), [state.serving])
  assert.equal(state.revisions[state.serving].spec.containers[0].image, image)
  assert.ok(state.peak <= 3)
}

test(
  'the executable Cloud Run model rejects deleting latest even without tags or traffic',
  options,
  () =>
    exercise((h) => {
      h.run('preflight')
      h.run('candidate')
      h.run('gcloud run services update-traffic "$SERVICE_NAME" --clear-tags')
      const result = h.run('gcloud run revisions delete "$CANDIDATE_REVISION"', false)
      assert.match(result.stderr, /FAILED_PRECONDITION: latest created Revision/)
    })
)

test(
  'success creates successor before retirement and repeated rollouts retain one consumer',
  options,
  () =>
    exercise((h) => {
      for (const attempt of ['1', '2']) {
        if (attempt === '2') {
          writeFileSync(join(h.dir, 'env'), 'GITHUB_RUN_ATTEMPT=2\n')
        }
        for (const key of ['preflight', 'candidate', 'activate', 'shift', 'public', 'retire']) {
          h.run(key)
        }
        const state = h.state()
        assert.equal(state.serving, `push-test-a123-${attempt}`)
        assert.deepEqual(Object.keys(state.revisions), [state.serving])
        assert.equal(state.peak, 3)
      }
    })
)

for (const failure of ['deploy-before', 'deploy-after', 'describe']) {
  test(`validation ${failure} recovers without deleting latest`, options, () =>
    exercise((h) => {
      h.run('preflight')
      h.change((state) => {
        state.failure = failure
      })
      h.run('candidate', false)
      recover(h)
    })
  )
}
for (const failure of ['deploy-before', 'deploy-after', 'delete', 'describe']) {
  test(
    `activation ${failure} frees validation slot before recovery and stays within three`,
    options,
    () =>
      exercise((h) => {
        h.run('preflight')
        h.run('candidate')
        h.change((state) => {
          state.failure = failure
        })
        h.run('activate', false)
        recover(h)
      })
  )
}

test(
  'ambiguous traffic shift records intent before mutation, rolls back and recovers',
  options,
  () =>
    exercise((h) => {
      h.run('preflight')
      h.run('candidate')
      h.run('activate')
      h.change((state) => {
        state.failure = 'traffic-after'
      })
      h.run('shift', false)
      assert.match(readFileSync(join(h.dir, 'env'), 'utf8'), /TRAFFIC_SHIFT_ATTEMPTED=true/)
      h.change((state) => {
        delete state.failure
      })
      h.run('rollback')
      recover(h)
    })
)

test('failed public check rolls back and recovers', options, () =>
  exercise((h) => {
    for (const key of ['preflight', 'candidate', 'activate', 'shift']) {
      h.run(key)
    }
    h.change((state) => {
      state.failure = 'public'
    })
    h.run('public', false)
    h.change((state) => {
      delete state.failure
    })
    h.run('rollback')
    recover(h)
  })
)

for (const defect of [
  'runtime',
  'secret',
  'mode',
  'image',
  'traffic',
  'scaling',
  'deploy-before',
  'deploy-after'
]) {
  test(`recovery rejects ${defect} and preserves partial-create state`, options, () =>
    exercise((h) => {
      h.run('preflight')
      h.run('candidate')
      h.change((state) => {
        const revision = state.revisions[state.latest]
        if (defect === 'runtime') {
          revision.spec.serviceAccountName = 'wrong@test'
        }
        if (defect === 'secret') {
          revision.spec.containers[0].env[0].valueFrom.secretKeyRef.key = '8'
        }
        if (defect === 'scaling') {
          revision.metadata.annotations['autoscaling.knative.dev/maxScale'] = '3'
        }
        if (defect === 'traffic') {
          state.serving = state.latest
        }
        if (defect.startsWith('deploy-')) {
          state.failure = defect
        }
      })
      // Corrupt the recovery response after the modeled deploy while keeping real jq assertions.
      const extra = ['mode', 'image'].includes(defect)
        ? `
      gcloud() {
        node "$MODEL_SCRIPT" "$@" > "$RUNNER_TEMP/out" || return $?
        if [[ "$*" == 'run services describe '* && "$*" == *'--format=json'* ]]; then
          jq '${defect === 'mode' ? '.spec.template.spec.containers[0].env += [{name:"ORCA_PUSH_MODE",value:"validation"}]' : '.spec.template.spec.containers[0].image = "wrong"'}' "$RUNNER_TEMP/out"
        else cat "$RUNNER_TEMP/out"; fi
      }`
        : ''
      h.run('restore', false, extra)
      const recorded = readFileSync(join(h.dir, 'env'), 'utf8')
      assert.match(recorded, /TEMPLATE_RECOVERY_REVISION=push-test-r123-1/)
      assert.doesNotMatch(recorded, /TEMPLATE_RESTORED=true/)
      assert.ok(h.state().peak <= 3)
    })
  )
}

test('failed validation retirement blocks a fourth revision during recovery', options, () =>
  exercise((h) => {
    h.run('preflight')
    h.run('candidate')
    h.change((state) => {
      state.failure = 'delete'
    })
    h.run('activate', false)
    h.run('restore', false)
    assert.equal(h.state().peak, 3)
    assert.equal(h.state().revisions['push-test-r123-1'], undefined)
  })
)

test(
  'failed retirement after public checks leaves verified serving and blocks the next run',
  options,
  () =>
    exercise((h) => {
      for (const key of ['preflight', 'candidate', 'activate', 'shift', 'public']) {
        h.run(key)
      }
      h.change((state) => {
        state.failure = 'delete'
      })
      h.run('retire', false)
      assert.equal(h.state().serving, 'push-test-a123-1')
      h.run('preflight', false)
      assert.match(workflow, /env.ROLLOUT_VERIFIED != 'true'/)
    })
)

test(
  'recovery promotion failure keeps consumers for operator diagnosis and blocks new rollout',
  options,
  () =>
    exercise((h) => {
      h.run('preflight')
      h.run('candidate')
      h.run('restore')
      h.change((state) => {
        state.failure = 'public'
      })
      h.run('promoteRecovery', false)
      assert.doesNotMatch(readFileSync(join(h.dir, 'env'), 'utf8'), /RECOVERY_VERIFIED=true/)
      h.run('preflight', false)
    })
)

const capability = step('Require image support for inert validation')
for (const [label, source, ok] of [
  ['old image', 'export function loadPushConfig() { return {}; }', false],
  [
    'invalid mode accepted',
    'export function loadPushConfig(env) { return { mode: env.ORCA_PUSH_MODE }; }',
    false
  ],
  [
    'validation supported',
    `export function loadPushConfig(env) {
    if (env.ORCA_PUSH_MODE !== 'validation') throw new Error('invalid mode');
    return { mode: 'validation' };
  }`,
    true
  ]
]) {
  test(`pre-production image smoke: ${label}`, options, () =>
    exercise((h) => {
      const dist = join(h.dir, 'apps', 'push', 'dist')
      mkdirSync(dist, { recursive: true })
      writeFileSync(join(h.dir, 'package.json'), '{"type":"module"}')
      writeFileSync(join(dist, 'config.js'), source)
      h.run(capability, ok, 'docker() { node "${@: -3}"; }')
    })
  )
}
