import { pathToFileURL } from 'node:url'
import { inspectAdmissionSelector } from './relay-admission-selector.mjs'

const DIRECTOR_ORIGIN = 'https://relay.onorca.dev'
const MODES = new Set(['inspect', 'enable', 'pause', 'disable', 'recover-enable'])

function canonicalCells(value) {
  if (value === 'none') return []
  const cells = value.split(',').map((cell) => cell.trim()).filter(Boolean).sort()
  if (
    cells.length === 0 ||
    new Set(cells).size !== cells.length ||
    cells.some((cell) => !/^production-gce-c(?:[1-9]|[12][0-9])$/.test(cell))
  ) throw new Error('selector membership is invalid')
  return cells
}

function integer(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return parsed
}

export function parseRegionalRehomeArguments(argv, environment = process.env) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['mode', 'director-origin', 'expected-control-generation']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (!MODES.has(values.mode)) throw new Error('--mode is invalid')
  if (values['director-origin'] !== DIRECTOR_ORIGIN) {
    throw new Error('--director-origin must be the production Relay origin')
  }
  const recovery = values.mode === 'recover-enable'
  const mutation = values.mode !== 'inspect' && !recovery
  const mutationKeys = [
    'not-before',
    'rate-per-minute',
    'preference-max-age-ms',
    'drain-grace-ms',
    'confirmation'
  ]
  if (mutation && mutationKeys.some((key) => values[key] === undefined)) {
    throw new Error('mutations require the complete durable control shape')
  }
  if (!mutation && !recovery && mutationKeys.some((key) => values[key] !== undefined)) {
    throw new Error('inspect cannot carry mutation arguments')
  }
  const selectorKeys = [
    'expected-selector-generation',
    'expected-existing-only-cells',
    'expected-migration-only-cells',
    'expected-general-cells'
  ]
  if (!recovery && selectorKeys.some((key) => values[key] === undefined)) {
    throw new Error('operation requires exact selector state')
  }
  if (recovery && selectorKeys.some((key) => values[key] !== undefined)) {
    throw new Error('enable recovery cannot depend on selector diagnostics')
  }
  const expectedConfirmation = {
    enable: 'ENABLE_REGIONAL_REHOMING',
    pause: 'PAUSE_REGIONAL_REHOMING',
    disable: 'DISABLE_REGIONAL_REHOMING'
  }[values.mode]
  if (mutation && values.confirmation !== expectedConfirmation) {
    throw new Error('confirmation does not match the requested control action')
  }
  if (recovery && values.confirmation !== 'RECOVER_FAILED_REGIONAL_REHOME_ENABLE') {
    throw new Error('confirmation does not authorize failed-enable recovery')
  }
  if (
    recovery &&
    mutationKeys
      .filter((key) => key !== 'confirmation')
      .some((key) => values[key] !== undefined)
  ) throw new Error('enable recovery cannot carry durable control shape arguments')
  const token = environment.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192) throw new Error('admin identity token is unavailable')
  return {
    mode: values.mode,
    directorOrigin: DIRECTOR_ORIGIN,
    ...(!recovery
      ? {
          expectedSelectorGeneration: integer(
            values['expected-selector-generation'],
            '--expected-selector-generation'
          ),
          expectedMembership: {
            existingOnly: canonicalCells(values['expected-existing-only-cells']),
            migrationOnly: canonicalCells(values['expected-migration-only-cells']),
            general: canonicalCells(values['expected-general-cells'])
          }
        }
      : {}),
    expectedControlGeneration: integer(
      values['expected-control-generation'],
      '--expected-control-generation'
    ),
    ...(mutation
      ? {
          notBefore: integer(values['not-before'], '--not-before'),
          ratePerMinute: integer(values['rate-per-minute'], '--rate-per-minute', {
            minimum: 1,
            maximum: 120
          }),
          preferenceMaxAgeMs: integer(
            values['preference-max-age-ms'],
            '--preference-max-age-ms',
            { minimum: 60_000, maximum: 30 * 24 * 60 * 60_000 }
          ),
          drainGraceMs: integer(values['drain-grace-ms'], '--drain-grace-ms', {
            minimum: 60_000,
            maximum: 60 * 60_000
          })
        }
      : {}),
    token
  }
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${body.error ?? 'unknown'}`)
  return body
}

function exactMembership(actual, expected) {
  return ['existingOnly', 'migrationOnly', 'general'].every(
    (key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key])
  )
}

function assertControl(control, expected) {
  if (
    (expected.generation !== undefined && control?.generation !== expected.generation) ||
    typeof control.enabled !== 'boolean' ||
    !Number.isSafeInteger(control.observationStartedAt) ||
    !Number.isSafeInteger(control.notBefore) ||
    !Number.isSafeInteger(control.ratePerMinute) ||
    !Number.isSafeInteger(control.preferenceMaxAgeMs) ||
    !Number.isSafeInteger(control.drainGraceMs)
  ) throw new Error('director returned an invalid regional rehome control')
  if (expected.enabled !== undefined && control.enabled !== expected.enabled) {
    throw new Error('regional rehome enabled state does not match')
  }
  return control
}

async function verifiedDisabledControl(post, generation) {
  return assertControl((await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'inspect'
  })).control, { generation, enabled: false })
}

async function applyDisabledControl(post, before) {
  return assertControl((await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'apply',
    expectedGeneration: before.generation,
    enabled: false,
    notBefore: before.notBefore,
    ratePerMinute: before.ratePerMinute,
    preferenceMaxAgeMs: before.preferenceMaxAgeMs,
    drainGraceMs: before.drainGraceMs,
    confirmation: 'DISABLE_REGIONAL_REHOMING'
  })).control, { generation: before.generation + 1, enabled: false })
}

async function resolveAmbiguousDisable(post, before, firstError) {
  const observed = assertControl((await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'inspect'
  })).control, {})
  if (observed.generation === before.generation + 1 && !observed.enabled) {
    return observed
  }
  if (observed.generation !== before.generation || !observed.enabled) {
    throw new AggregateError(
      [firstError],
      'failed-enable recovery reached an unexpected control generation'
    )
  }
  try {
    return await applyDisabledControl(post, before)
  } catch (retryError) {
    try {
      return await verifiedDisabledControl(post, before.generation + 1)
    } catch (readbackError) {
      throw new AggregateError(
        [firstError, retryError, readbackError],
        'failed-enable recovery exhausted two bounded CAS attempts'
      )
    }
  }
}

export async function recoverRegionalRehomeEnable(config, post) {
  const before = assertControl((await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'inspect'
  })).control, {})
  if (
    before.generation < config.expectedControlGeneration ||
    (before.generation === config.expectedControlGeneration && before.enabled)
  ) throw new Error('durable control cannot belong to the failed enable attempt')
  if (!before.enabled) {
    const verified = await verifiedDisabledControl(post, before.generation)
    return { mode: config.mode, recovered: false, control: verified }
  }
  let applied
  try {
    applied = await applyDisabledControl(post, before)
  } catch (error) {
    applied = await resolveAmbiguousDisable(post, before, error)
  }
  const verified = await verifiedDisabledControl(post, applied.generation)
  return { mode: config.mode, recovered: true, control: verified }
}

export async function operateRegionalRehome(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch
  const post = dependencies.post ?? (async (path, body) => await responseJson(
    await fetchImpl(`${config.directorOrigin}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    }),
    path
  ))
  if (config.mode === 'recover-enable') {
    return await recoverRegionalRehomeEnable(config, post)
  }
  const selector = (await inspectAdmissionSelector(post)).selector
  if (
    selector.generation !== config.expectedSelectorGeneration ||
    !exactMembership(selector.membership, config.expectedMembership)
  ) throw new Error('admission selector does not match the reviewed generation and membership')

  const inspected = await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'inspect'
  })
  const before = assertControl(inspected.control, {
    generation: config.expectedControlGeneration
  })
  if (config.mode === 'inspect') return { mode: config.mode, selector, control: before }
  if (config.mode === 'enable' && before.enabled) {
    throw new Error('regional rehome is already enabled; inspect before changing its rate')
  }
  if (config.mode === 'pause' && !before.enabled) {
    throw new Error('regional rehome is already paused')
  }
  const enabled = config.mode === 'enable'
  const applied = await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'apply',
    expectedGeneration: config.expectedControlGeneration,
    enabled,
    notBefore: config.notBefore,
    ratePerMinute: config.ratePerMinute,
    preferenceMaxAgeMs: config.preferenceMaxAgeMs,
    drainGraceMs: config.drainGraceMs,
    confirmation: enabled
      ? 'ENABLE_REGIONAL_REHOMING'
      : 'DISABLE_REGIONAL_REHOMING'
  })
  const after = assertControl(applied.control, {
    generation: config.expectedControlGeneration + 1,
    enabled
  })
  const verified = assertControl((await post('/v1/admin/regional-rehome-control', {
    v: 1,
    action: 'inspect'
  })).control, {
    generation: after.generation,
    enabled
  })
  return { mode: config.mode, selector, control: verified }
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
  write = (value) => process.stdout.write(value)
) {
  const result = await operateRegionalRehome(
    parseRegionalRehomeArguments(argv, environment),
    dependencies
  )
  write(`${JSON.stringify({ event: 'relay_regional_rehome_control', ...result })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
