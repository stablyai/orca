import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  addExactMigrationCells,
  applyExactAdmissionSelector,
  inspectAdmissionSelector,
  membershipWithStates,
  selectorCellState
} from './relay-admission-selector.mjs'

const SHAPES = {
  staging: {
    directorOrigin: 'https://relay-staging.onorca.dev',
    domain: 'relay-staging.onorca.dev',
    allCells: ['staging-gce-c4']
  },
  production: {
    directorOrigin: 'https://relay.onorca.dev',
    domain: 'relay.onorca.dev',
    allCells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29']
  }
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['environment', 'mode', 'cell-ids', 'image-digest']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(values['image-digest'])) {
    throw new Error('--image-digest is invalid')
  }
  if (![
    'inspect', 'initialize', 'verify', 'registered', 'register',
    'promote', 'recover-promotion', 'rollback'
  ].includes(values.mode)) {
    throw new Error('--mode is invalid')
  }
  const expectedGeneration = values.mode === 'inspect'
    ? undefined
    : Number(values['expected-generation'])
  if (
    values.mode !== 'inspect' &&
    (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
  ) {
    throw new Error('--expected-generation is invalid')
  }
  const shape = SHAPES[values.environment]
  if (!shape) throw new Error('--environment is invalid')
  const cells = values['cell-ids'].split(',').map((value) => value.trim()).filter(Boolean)
  const distinct = new Set(cells)
  if (distinct.size !== cells.length || cells.some((cell) => !shape.allCells.includes(cell))) {
    throw new Error('--cell-ids are invalid')
  }
  const exact = (expected) => JSON.stringify([...cells].sort()) === JSON.stringify([...expected].sort())
  if (
    (['inspect', 'initialize', 'register', 'registered', 'verify'].includes(values.mode) &&
      !exact(shape.allCells)) ||
    (['promote', 'recover-promotion'].includes(values.mode) && values.environment === 'production' &&
      !exact(['production-gce-c27']) && !exact(['production-gce-c28', 'production-gce-c29'])) ||
    (['promote', 'recover-promotion'].includes(values.mode) && values.environment === 'staging' && !exact(shape.allCells)) ||
    (values.mode === 'rollback' && cells.length === 0)
  ) throw new Error('--cell-ids do not match the reviewed admission wave')
  const attemptId = values['attempt-id']
  if (!['inspect', 'verify', 'registered'].includes(values.mode) &&
    !/^[A-Za-z0-9_-]{8,128}$/.test(attemptId ?? '')) {
    throw new Error('--attempt-id is invalid')
  }
  return {
    environment: values.environment,
    mode: values.mode,
    cells,
    expectedGeneration,
    expectedMembershipSha256: values['expected-membership-sha256'],
    imageDigest: values['image-digest'],
    attemptId,
    token: process.env.ORCA_RELAY_ADMIN_ID_TOKEN ?? ''
  }
}

function hostname(cellId) {
  return cellId.split('-').at(-1)
}

function cellOrigin(shape, cellId) {
  return `https://${hostname(cellId)}.${shape.domain}`
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned ${response.status}`)
  return body
}

function defaultPost(fetchImpl, token) {
  return async (url, body) => await responseJson(await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  }), new URL(url).pathname)
}

async function verifyRuntime(fetchImpl, post, shape, cellId, imageDigest, requireDirector) {
  const origin = cellOrigin(shape, cellId)
  const [health, ready, runtime] = await Promise.all([
    fetchImpl(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(8_000) }),
    fetchImpl(`${origin}/ready`, { redirect: 'error', signal: AbortSignal.timeout(8_000) }),
    post(`${origin}/v1/admin/runtime-status`, { v: 1 })
  ])
  if (!health.ok || !ready.ok) throw new Error(`${cellId} is not ready`)
  if (
    runtime.cellId !== cellId ||
    runtime.cellUrl !== origin ||
    runtime.region !== 'asia-east2' ||
    runtime.imageDigest !== imageDigest ||
    runtime.draining !== false ||
    runtime.connectionCapacity?.hardCap !== 3_000 ||
    runtime.connectionCapacity?.unobservedBound !== 60
  ) throw new Error(`${cellId} runtime does not match the reviewed Asia shape`)
  if (requireDirector) {
    const result = await post(`${shape.directorOrigin}/v1/admin/cell-status`, { v: 1, cellId })
    if (
      result.status?.cellUrl !== origin ||
      result.status?.runtime?.heartbeatFresh !== true ||
      result.status?.runtime?.ready !== true
    ) throw new Error(`${cellId} has no fresh ready director heartbeat`)
  }
}

function membershipStates(selector, cells) {
  return Object.fromEntries(cells.map((cellId) => [cellId, selectorCellState(selector, cellId)]))
}

function inspectedMembershipStates(selector, cells) {
  const known = new Set([
    ...selector.membership.existingOnly,
    ...selector.membership.migrationOnly,
    ...selector.membership.general
  ])
  return Object.fromEntries(cells.map((cellId) => [
    cellId,
    known.has(cellId) ? selectorCellState(selector, cellId) : 'absent'
  ]))
}

function sameMembership(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function membershipSha256(membership) {
  return createHash('sha256').update(JSON.stringify(membership)).digest('hex')
}

async function initializeAdmissionBoundary(post, selectorPost, shape, config, current) {
  if (config.expectedGeneration !== 0) {
    throw new Error('admission boundary initialization requires generation 0')
  }
  if (
    !/^[a-f0-9]{64}$/.test(config.expectedMembershipSha256 ?? '') ||
    membershipSha256(current.selector.membership) !== config.expectedMembershipSha256
  ) {
    throw new Error('admission membership changed before boundary initialization')
  }
  const targetStates = inspectedMembershipStates(current.selector, config.cells)
  if (Object.values(targetStates).some((state) => state !== 'absent')) {
    throw new Error('Asia cell exists before admission boundary initialization')
  }
  const intendedMembership = current.intent?.previousMembership ?? current.selector.membership
  const exactCommitted = (inspection) =>
    inspection.intent?.state === 'committed' &&
    inspection.intent.expectedGeneration === 0 &&
    inspection.selector.generation === 1 &&
    inspection.selector.attemptId === config.attemptId &&
    sameMembership(inspection.intent.previousMembership, intendedMembership) &&
    sameMembership(inspection.intent.membership, intendedMembership) &&
    sameMembership(inspection.selector.membership, intendedMembership)
  const exactUnchanged = (inspection) =>
    inspection.intent?.state === 'unchanged' &&
    inspection.intent.expectedGeneration === 0 &&
    inspection.selector.generation === 0 &&
    sameMembership(inspection.intent.previousMembership, intendedMembership) &&
    sameMembership(inspection.intent.membership, intendedMembership) &&
    sameMembership(inspection.selector.membership, intendedMembership)
  if (exactCommitted(current)) {
    return {
      mode: config.mode,
      generation: current.selector.generation,
      states: inspectedMembershipStates(current.selector, config.cells),
      recovered: true
    }
  }
  if (current.intent && !exactUnchanged(current)) {
    throw new Error('admission boundary initialization attempt diverged')
  }
  const request = {
    v: 1,
    attemptId: config.attemptId,
    expectedGeneration: 0,
    expectedMembershipSha256: config.expectedMembershipSha256,
    membership: intendedMembership
  }
  let applyError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await post(`${shape.directorOrigin}/v1/admin/admission-selector/apply`, request)
    } catch (error) {
      applyError = error
    }
    const verified = await inspectAdmissionSelector(selectorPost, config.attemptId)
    if (exactCommitted(verified)) {
      return {
        mode: config.mode,
        generation: verified.selector.generation,
        states: targetStates,
        recovered: current.intent !== null || applyError !== undefined || attempt > 0
      }
    }
    if (!exactUnchanged(verified)) {
      throw new Error('admission boundary initialization did not commit exactly', {
        cause: applyError
      })
    }
  }
  throw new Error('admission boundary initialization remained unchanged after retry', {
    cause: applyError
  })
}

export async function operateRelayAsiaAdmission(config, dependencies = {}) {
  const shape = SHAPES[config.environment]
  const fetchImpl = dependencies.fetch ?? fetch
  const post = dependencies.post ?? defaultPost(fetchImpl, config.token)
  const selectorPost = (path, body) => {
    if (config.environment !== 'staging' || path !== '/v1/admin/admission-selector/apply') {
      return post(`${shape.directorOrigin}${path}`, body)
    }
    const state = selectorCellState({ membership: body.membership }, 'staging-gce-c4')
    if (!['general', 'migration-only'].includes(state)) {
      throw new Error('staging proof can only transition C4 between reviewed states')
    }
    return post(`${shape.directorOrigin}/v1/admin/admission-selector/apply-staging-asia-proof`, {
      v: 1,
      attemptId: body.attemptId,
      expectedGeneration: body.expectedGeneration,
      state
    })
  }
  const current = await inspectAdmissionSelector(
    selectorPost,
    ['inspect', 'verify', 'registered'].includes(config.mode) ? undefined : config.attemptId
  )
  if (config.mode === 'inspect') {
    return {
      mode: config.mode,
      generation: current.selector.generation,
      membership: current.selector.membership,
      membershipSha256: membershipSha256(current.selector.membership),
      states: inspectedMembershipStates(current.selector, config.cells)
    }
  }
  if (
    !current.intent &&
    current.selector.generation !== config.expectedGeneration
  ) {
    throw new Error('admission selector generation changed')
  }
  if (current.intent && current.intent.expectedGeneration !== config.expectedGeneration) {
    throw new Error('admission attempt generation does not match')
  }
  if (config.mode === 'initialize') {
    return await initializeAdmissionBoundary(post, selectorPost, shape, config, current)
  }
  if (config.mode === 'recover-promotion') {
    if (config.cells.every(
      (cellId) => selectorCellState(current.selector, cellId) === 'migration-only'
    )) {
      return {
        mode: config.mode,
        promoted: false,
        generation: current.selector.generation,
        states: membershipStates(current.selector, config.cells)
      }
    }
    if (!current.intent) {
      if (
        current.selector.generation !== config.expectedGeneration
      ) throw new Error('promotion state changed without the reviewed attempt')
      return {
        mode: config.mode,
        promoted: false,
        generation: current.selector.generation,
        states: membershipStates(current.selector, config.cells)
      }
    }
    const expectedMembership = membershipWithStates(
      { membership: current.intent.previousMembership },
      Object.fromEntries(config.cells.map((cellId) => [cellId, 'general']))
    )
    if (
      current.intent.state !== 'committed' ||
      JSON.stringify(current.intent.membership) !== JSON.stringify(expectedMembership) ||
      config.cells.some((cellId) => selectorCellState(current.selector, cellId) !== 'general')
    ) throw new Error('promotion attempt is not the current general state')
    return {
      mode: config.mode,
      promoted: true,
      generation: current.selector.generation,
      states: membershipStates(current.selector, config.cells)
    }
  }
  if (config.mode === 'rollback') {
    for (const cellId of config.cells) {
      if (!['general', 'migration-only'].includes(selectorCellState(current.selector, cellId))) {
        throw new Error(`${cellId} cannot roll back to migration-only`)
      }
    }
  } else if (config.mode === 'register') {
    const known = new Set([
      ...current.selector.membership.existingOnly,
      ...current.selector.membership.migrationOnly,
      ...current.selector.membership.general
    ])
    if (!current.intent && config.cells.some((cellId) => known.has(cellId))) {
      throw new Error('Asia cell is already registered')
    }
    await Promise.all(config.cells.map((cellId) =>
      verifyRuntime(fetchImpl, post, shape, cellId, config.imageDigest, false)
    ))
  } else if (config.mode !== 'registered') {
    await Promise.all(config.cells.map((cellId) =>
      verifyRuntime(fetchImpl, post, shape, cellId, config.imageDigest, true)
    ))
  }
  if (config.mode === 'registered') {
    if (config.cells.some(
      (cellId) => selectorCellState(current.selector, cellId) !== 'migration-only'
    )) throw new Error('Asia cells are not registered migration-only')
    await Promise.all(config.cells.map((cellId) =>
      verifyRuntime(fetchImpl, post, shape, cellId, config.imageDigest, false)
    ))
  }
  if (['verify', 'registered'].includes(config.mode)) {
    return {
      mode: config.mode,
      generation: current.selector.generation,
      states: membershipStates(current.selector, config.cells)
    }
  }
  if (config.mode === 'register') {
    if (current.intent) {
      const expectedCells = new Set(config.cells)
      const addedCells = current.intent.membership.migrationOnly.filter(
        (cellId) => !current.intent.previousMembership.migrationOnly.includes(cellId)
      )
      if (
        current.intent.state !== 'committed' ||
        addedCells.length !== expectedCells.size ||
        addedCells.some((cellId) => !expectedCells.has(cellId)) ||
        current.selector.generation !== config.expectedGeneration + 1 ||
        JSON.stringify(current.selector.membership) !== JSON.stringify(current.intent.membership)
      ) {
        throw new Error('admission attempt does not match the requested Asia registration')
      }
      return {
        mode: config.mode,
        generation: current.selector.generation,
        states: membershipStates(current.selector, config.cells),
        recovered: true
      }
    }
    const result = await addExactMigrationCells(
      selectorPost,
      {
        attemptId: config.attemptId,
        cells: config.cells.map((cellId) => ({
          cellId,
          cellUrl: cellOrigin(shape, cellId),
          region: 'asia-east2',
          capacityRequests: 6_000,
          connectionHardCap: 3_000,
          connectionUnobservedBound: 60
        }))
      },
      { expectedCurrentSelector: current.selector }
    )
    return { mode: config.mode, generation: result.selector.generation, states: membershipStates(result.selector, config.cells) }
  }
  const desiredState = config.mode === 'promote' ? 'general' : 'migration-only'
  if (current.intent) {
    const expectedMembership = membershipWithStates(
      { membership: current.intent.previousMembership },
      Object.fromEntries(config.cells.map((cellId) => [cellId, desiredState]))
    )
    if (
      current.intent.state !== 'committed' ||
      JSON.stringify(current.intent.membership) !== JSON.stringify(expectedMembership) ||
      current.selector.generation !== config.expectedGeneration + 1 ||
      JSON.stringify(current.selector.membership) !== JSON.stringify(current.intent.membership)
    ) {
      throw new Error('admission attempt does not match the requested Asia transition')
    }
    return {
      mode: config.mode,
      generation: current.selector.generation,
      states: membershipStates(current.selector, config.cells),
      recovered: true
    }
  }
  if (config.mode === 'promote' && config.cells.some(
    (cellId) => selectorCellState(current.selector, cellId) !== 'migration-only'
  )) throw new Error('Asia promotion requires migration-only cells')
  if (
    config.mode === 'promote' &&
    config.environment === 'production' &&
    config.cells.includes('production-gce-c28') &&
    selectorCellState(current.selector, 'production-gce-c27') !== 'general'
  ) {
    throw new Error('Asia expansion requires the C27 canary to be general')
  }
  const result = await applyExactAdmissionSelector(
    selectorPost,
    membershipWithStates(current.selector, Object.fromEntries(
      config.cells.map((cellId) => [cellId, desiredState])
    )),
    { attemptId: config.attemptId, expectedCurrentSelector: current.selector }
  )
  return { mode: config.mode, generation: result.selector.generation, states: membershipStates(result.selector, config.cells) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = parseArguments(process.argv.slice(2))
  if (!config.token) throw new Error('ORCA_RELAY_ADMIN_ID_TOKEN is required')
  console.log(JSON.stringify(await operateRelayAsiaAdmission(config)))
}
