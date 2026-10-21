import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readRelayWorkflow } from './relay-repository.mjs'

const parent = readRelayWorkflow('deploy-relay-production-same-cap.yml')
const job = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')

function jobAcceptedModes() {
  const match = /\[\[ "\$\{DEPLOY_MODE\}" =~ \^\(([a-z|-]+)\)\$ \]\]/.exec(job)
  assert.ok(match, 'the job no longer validates DEPLOY_MODE')
  return new Set(match[1].split('|'))
}

// Mirrors the gate step's dispatch-mode to job-mode mapping.
function parentJobModes() {
  const options = /mode:\n\s+description:[^\n]*\n(?:\s+[a-z]+:[^\n]*\n)*?\s+options: \[([^\]]+)\]/
    .exec(parent)
  assert.ok(options, 'the parent has no dispatch mode options')
  const collapsed = /if \[\[ "\$\{MODE\}" =~ \^\(([a-z|-]+)\)\$ \]\]; then\n\s+echo 'job-mode=([a-z]+)'/
    .exec(parent)
  assert.ok(collapsed, 'the parent no longer collapses apply modes into one job mode')
  const collapsedModes = new Set(collapsed[1].split('|'))
  return new Set(
    options[1].split(',').map((mode) => mode.trim()).map((mode) =>
      collapsedModes.has(mode) ? collapsed[2] : mode
    )
  )
}

function stepCondition(name) {
  const start = job.indexOf(`- name: ${name}\n`)
  assert.notEqual(start, -1, `job has no step named ${name}`)
  const step = job.slice(start, job.indexOf('\n      - ', start + 1))
  const condition = /^ {8}if: \$\{\{ (.+) \}\}$/m.exec(step)
  assert.ok(condition, `${name} has no if condition`)
  return condition[1]
}

// Just enough of the expression grammar for the step conditions this file compares.
function evaluate(expression, context) {
  const tokens = expression.match(/'[^']*'|[A-Za-z_.]+|==|!=|&&|\|\||[()]/g)
  assert.equal(tokens.join(''), expression.replaceAll(' ', ''), `unparsed: ${expression}`)
  let index = 0
  const value = () => {
    const token = tokens[index++]
    if (token === '(') {
      const inner = or()
      assert.equal(tokens[index++], ')')
      return inner
    }
    if (token.startsWith("'")) return token.slice(1, -1)
    assert.ok(Object.hasOwn(context, token), `unknown operand ${token}`)
    return context[token]
  }
  const comparison = () => {
    const left = value()
    if (tokens[index] !== '==' && tokens[index] !== '!=') return left
    const operator = tokens[index++]
    const right = value()
    return operator === '==' ? left === right : left !== right
  }
  const and = () => {
    let result = comparison()
    while (tokens[index] === '&&') {
      index++
      result = comparison() && result
    }
    return result
  }
  const or = () => {
    let result = and()
    while (tokens[index] === '||') {
      index++
      result = or() || result
    }
    return result
  }
  const result = or()
  assert.equal(index, tokens.length, `unparsed tail: ${expression}`)
  return result
}

test('the parent passes only modes the job accepts', () => {
  assert.deepEqual(parentJobModes(), jobAcceptedModes())
})

// A comparison against a mode the job never receives is constant, so its step is dead (#24259).
test('every job mode comparison names a mode the job can receive', () => {
  const accepted = jobAcceptedModes()
  const compared = [...job.matchAll(/inputs\.mode\s*[!=]=\s*'([^']*)'/g)].map(([, mode]) => mode)
  assert.ok(compared.length > 0)
  for (const mode of compared) assert.ok(accepted.has(mode), `job compares against ${mode}`)
})

test('the headroom gate runs whenever the drain runs, and in verify', () => {
  const headroom = stepCondition("Require free general-cell slots for the selected cell's hosts")
  const drain = stepCondition('Reversibly isolate and drain only the selected cell')
  for (const mode of parentJobModes()) {
    for (const resume of ['true', 'false']) {
      const context = { 'inputs.mode': mode, 'env.ROLLBACK_RESUME': resume }
      if (evaluate(drain, context)) {
        assert.ok(evaluate(headroom, context), `drain without headroom check: ${mode}/${resume}`)
      }
    }
  }
  assert.ok(evaluate(headroom, { 'inputs.mode': 'verify', 'env.ROLLBACK_RESUME': 'false' }))
})

// The roll's fleet-health gate lives inside the job now; a separate monitor run must not creep back.
test('neither same-cap workflow depends on monitor evidence', () => {
  for (const [name, text] of [['parent', parent], ['job', job]]) {
    for (const pattern of [
      /monitor-run-(id|attempt)/,
      /MONITOR_RUN_/,
      /relay-monitor-evidence/,
      /relay-monitor-dry-run-/,
      /monitor-consumed/,
      /gate-override/,
      /GATE_OVERRIDE/,
      /SKIP_RELAY_MONITOR_GATE/,
      /--state-file/
    ]) {
      assert.doesNotMatch(text, pattern, `${name} still references ${pattern}`)
    }
  }
})

test('every apply wave samples fleet health right before it drains', () => {
  const sampleName = 'Sample fleet health for a window sized to this drain'
  const sample = stepCondition(sampleName)
  const drain = stepCondition('Reversibly isolate and drain only the selected cell')
  for (const mode of parentJobModes()) {
    for (const resume of ['true', 'false']) {
      const context = { 'inputs.mode': mode, 'env.ROLLBACK_RESUME': resume }
      if (mode === 'apply' && evaluate(drain, context)) {
        assert.ok(evaluate(sample, context), `apply drain without a sample: ${resume}`)
      }
    }
  }
  assert.equal(evaluate(sample, { 'inputs.mode': 'verify' }), false)
  assert.equal(evaluate(sample, { 'inputs.mode': 'rollback' }), false)
  const at = (name) => {
    const index = job.indexOf(`- name: ${name}\n`)
    assert.notEqual(index, -1, name)
    return index
  }
  const order = [
    'Recheck aggregate SQL, pool, reconnect, migration, and selector safety',
    "Require free general-cell slots for the selected cell's hosts",
    sampleName,
    'Reversibly isolate and drain only the selected cell'
  ].map(at)
  assert.deepEqual(order, [...order].sort((left, right) => left - right))
  const step = job.slice(at(sampleName), job.indexOf('\n      - ', at(sampleName) + 1))
  // The window is sized from the headroom step's own count, and each wave offsets its selector.
  assert.match(step, /pnpm incident:relay-pre-drain-sample/)
  assert.match(step, /--target-hosts "\$\{TARGET_HOSTS\}"/)
  // The crash rule exempts the cell being rolled, so it must be told which one that is.
  assert.match(step, /--target-cell-id "\$\{TARGET_CELL_ID\}"/)
  assert.match(step, /--wave-index "\$\{WAVE_INDEX\}"/)
  assert.match(step, /--selector-wave-delta "\$\{SELECTOR_WAVE_DELTA\}"/)
  assert.match(job, /echo "TARGET_HOSTS=\$\{TARGET_HOSTS\}" >> "\$\{GITHUB_ENV\}"/)
})
