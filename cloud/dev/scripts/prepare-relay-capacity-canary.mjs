import { pathToFileURL } from 'node:url'
import {
  applyExactAdmissionSelector,
  inspectAdmissionSelector,
  membershipWithStates,
  selectorCellState
} from './relay-admission-selector.mjs'

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['director-origin', 'cell-id', 'mode']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  const origin = new URL(values['director-origin'])
  if (origin.protocol !== 'https:' || origin.origin !== values['director-origin']) {
    throw new Error('--director-origin must be a canonical HTTPS origin')
  }
  if (!['isolate', 'activate', 'restore-fallback', 'restore'].includes(values.mode)) {
    throw new Error('--mode must be isolate, activate, restore-fallback, or restore')
  }
  const cellOrigin = values['cell-origin'] ? new URL(values['cell-origin']) : null
  if (
    values.mode === 'isolate' &&
    (!cellOrigin || cellOrigin.protocol !== 'https:' || cellOrigin.origin !== values['cell-origin'])
  ) {
    throw new Error('--cell-origin must be a canonical HTTPS origin for isolate mode')
  }
  const restoreGeneralCellIds = values['general-cell-ids']?.split(',').filter(Boolean) ?? []
  if (
    ['restore-fallback', 'restore'].includes(values.mode) &&
    restoreGeneralCellIds.length === 0
  ) {
    throw new Error('--general-cell-ids is required for restore modes')
  }
  if (values.mode === 'restore' && !restoreGeneralCellIds.includes(values['cell-id'])) {
    throw new Error('--general-cell-ids must include the canary for restore mode')
  }
  if (values.mode === 'restore-fallback' && restoreGeneralCellIds.includes(values['cell-id'])) {
    throw new Error('--general-cell-ids cannot include the canary for fallback restore')
  }
  if (new Set(restoreGeneralCellIds).size !== restoreGeneralCellIds.length) {
    throw new Error('--general-cell-ids must be distinct')
  }
  return {
    directorOrigin: origin.origin,
    cellOrigin: cellOrigin?.origin,
    cellId: values['cell-id'],
    mode: values.mode,
    restoreGeneralCellIds
  }
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned ${response.status}`)
  return body
}

function sameMembership(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function legacyCellState(post, cellId) {
  const result = await post('/v1/admin/cell-status', { v: 1, cellId })
  if (result.status?.cellId !== cellId) throw new Error('legacy admission status is invalid')
  const state = result.status.admissionState
  if (!['existing-only', 'migration-only', 'general'].includes(state)) {
    throw new Error('legacy admission status is invalid')
  }
  return state
}

async function applyLegacyStates(post, before, states, order) {
  const expected = membershipWithStates(before.selector, states)
  let changed = false
  for (const cellId of order) {
    const desired = states[cellId]
    const current = await legacyCellState(post, cellId)
    if (current === 'existing-only' && desired !== current) {
      throw new Error(`legacy admission cannot re-enable existing-only cell ${cellId}`)
    }
    if (current === desired) continue
    let cause
    try {
      await post('/v1/admin/cell-state', { v: 1, cellId, state: desired })
    } catch (error) {
      cause = error
    }
    if ((await legacyCellState(post, cellId)) !== desired) {
      const detail = cause instanceof Error ? `: ${cause.message}` : ''
      throw new Error(`legacy admission did not commit ${cellId} exactly${detail}`, { cause })
    }
    changed = true
  }
  const verified = await inspectAdmissionSelector(post)
  if (verified.selector.generation !== 0 ||
      !sameMembership(verified.selector.membership, expected)) {
    throw new Error('legacy admission membership changed unexpectedly')
  }
  return { changed, selector: verified.selector }
}

export async function prepareCapacityCanary(config, overrides = {}) {
  const fetchImpl = overrides.fetch ?? fetch
  const token = overrides.token ?? process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192) throw new Error('admin identity token is unavailable')
  const postAt = async (origin, path, body) =>
    await responseJson(
      await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      }),
      path
    )
  const post = async (path, body) => await postAt(config.directorOrigin, path, body)
  const before = await inspectAdmissionSelector(post)
  const state = selectorCellState(before.selector, config.cellId)
  if (state === 'existing-only' && config.mode !== 'restore-fallback') {
    throw new Error('capacity canary cannot restore existing-only admission')
  }
  const states =
    config.mode === 'isolate'
      ? { [config.cellId]: 'migration-only' }
      : config.mode === 'activate'
        ? Object.fromEntries([
            ...before.selector.membership.general.map((cellId) => [
              cellId,
              cellId === config.cellId ? 'general' : 'migration-only'
            ]),
            [config.cellId, 'general']
          ])
        : Object.fromEntries([
            ...config.restoreGeneralCellIds.map((cellId) => [cellId, 'general']),
            ...(config.mode === 'restore-fallback'
              ? [[config.cellId, state === 'existing-only' ? 'existing-only' : 'migration-only']]
              : [])
          ])
  const membership = membershipWithStates(before.selector, states)
  const legacyOrder =
    config.mode === 'activate'
      ? [config.cellId, ...before.selector.membership.general.filter((id) => id !== config.cellId)]
      : config.mode === 'restore-fallback'
        ? [...config.restoreGeneralCellIds, config.cellId]
        : Object.keys(states)
  const result = before.selector.generation === 0
    ? await applyLegacyStates(post, before, states, legacyOrder)
    : sameMembership(membership, before.selector.membership)
      ? { changed: false, selector: before.selector }
      : await applyExactAdmissionSelector(post, membership, {
          expectedCurrentSelector: before.selector
        })
  if (config.mode === 'isolate') {
    await postAt(config.cellOrigin, '/v1/admin/drain', { v: 1, graceMs: 0 })
  }
  return {
    changed: result.changed,
    generation: result.selector.generation,
    ...(config.mode === 'isolate' ? { drained: true } : {})
  }
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArguments(argv)
  const result = await prepareCapacityCanary(config)
  process.stdout.write(
    `${JSON.stringify({ event: 'relay_capacity_canary_admission', cellId: config.cellId, mode: config.mode, ...result })}\n`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
