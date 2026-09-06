import { createHash } from 'node:crypto'

const STATES = ['existing-only', 'migration-only', 'general']

function normalizeMembership(input) {
  const membership = {
    existingOnly: [...input.existingOnly].sort(),
    migrationOnly: [...input.migrationOnly].sort(),
    general: [...input.general].sort()
  }
  const all = [...membership.existingOnly, ...membership.migrationOnly, ...membership.general]
  if (new Set(all).size !== all.length) throw new Error('selector membership contains duplicates')
  return membership
}

function encodedMembership(membership) {
  return JSON.stringify(normalizeMembership(membership))
}

function membershipSha256(membership) {
  return createHash('sha256').update(encodedMembership(membership)).digest('hex')
}

function normalizeMigrationCells(input) {
  const cells = [...input]
    .map((cell) => ({
      cellId: cell.cellId,
      cellUrl: cell.cellUrl,
      capacityRequests: cell.capacityRequests,
      ...(cell.region ? { region: cell.region } : {}),
      connectionHardCap: cell.connectionHardCap,
      connectionUnobservedBound: cell.connectionUnobservedBound
    }))
    .sort((left, right) => left.cellId.localeCompare(right.cellId))
  if (
    cells.length === 0 ||
    new Set(cells.map(({ cellId }) => cellId)).size !== cells.length ||
    new Set(cells.map(({ cellUrl }) => cellUrl)).size !== cells.length
  ) {
    throw new Error('migration cell registration must contain distinct cells')
  }
  return cells
}

function membershipWithMigrationCells(membership, cells) {
  const known = new Set([
    ...membership.existingOnly,
    ...membership.migrationOnly,
    ...membership.general
  ])
  if (cells.some(({ cellId }) => known.has(cellId))) {
    throw new Error('migration cell registration contains an existing selector cell')
  }
  return normalizeMembership({
    existingOnly: membership.existingOnly,
    migrationOnly: [...membership.migrationOnly, ...cells.map(({ cellId }) => cellId)],
    general: membership.general
  })
}

function assertSelector(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !value.membership
  ) {
    throw new Error('director returned an invalid admission selector')
  }
  return {
    generation: value.generation,
    attemptId: value.attemptId ?? null,
    membership: normalizeMembership(value.membership)
  }
}

export function selectorAttemptId(expectedGeneration, membership) {
  const digest = createHash('sha256')
    .update(`${expectedGeneration}:${encodedMembership(membership)}`)
    .digest('hex')
    .slice(0, 24)
  return `selector_${expectedGeneration}_${digest}`
}

export function membershipWithStates(selector, states) {
  const byCell = new Map()
  for (const [state, key] of [
    ['existing-only', 'existingOnly'],
    ['migration-only', 'migrationOnly'],
    ['general', 'general']
  ]) {
    for (const cellId of selector.membership[key]) byCell.set(cellId, state)
  }
  for (const [cellId, state] of Object.entries(states)) {
    if (!byCell.has(cellId)) throw new Error(`selector does not contain ${cellId}`)
    if (!STATES.includes(state)) throw new Error(`invalid admission state for ${cellId}`)
    if (byCell.get(cellId) === 'existing-only' && state !== 'existing-only') {
      throw new Error(`selector cannot re-enable existing-only cell ${cellId}`)
    }
    byCell.set(cellId, state)
  }
  return normalizeMembership({
    existingOnly: [...byCell].filter(([, state]) => state === 'existing-only').map(([id]) => id),
    migrationOnly: [...byCell].filter(([, state]) => state === 'migration-only').map(([id]) => id),
    general: [...byCell].filter(([, state]) => state === 'general').map(([id]) => id)
  })
}

export async function inspectAdmissionSelector(post, attemptId) {
  const result = await post('/v1/admin/admission-selector/status', {
    v: 1,
    ...(attemptId ? { attemptId } : {})
  })
  return {
    selector: assertSelector(result.selector),
    intent: result.intent
      ? {
          ...result.intent,
          previousMembership: result.intent.previousMembership
            ? normalizeMembership(result.intent.previousMembership)
            : undefined,
          membership: normalizeMembership(result.intent.membership)
        }
      : null
  }
}

function exactSelector(actual, expected) {
  return (
    actual.generation === expected.generation &&
    encodedMembership(actual.membership) === encodedMembership(expected.membership)
  )
}

export async function applyExactAdmissionSelector(post, membership, options = {}) {
  const before = await inspectAdmissionSelector(post)
  const desired = normalizeMembership(membership)
  if (
    options.expectedCurrentSelector &&
    !exactSelector(before.selector, options.expectedCurrentSelector)
  ) {
    throw new Error('admission selector changed before exact apply')
  }
  if (options.requireBoundary !== false && before.selector.generation < 1) {
    throw new Error('admission selector boundary is not active')
  }
  if (encodedMembership(before.selector.membership) === encodedMembership(desired)) {
    return { changed: false, selector: before.selector }
  }
  const attemptId =
    options.attemptId ?? selectorAttemptId(before.selector.generation, desired)
  const expected = {
    generation: before.selector.generation + 1,
    membership: desired
  }
  let result
  try {
    result = await post('/v1/admin/admission-selector/apply', {
      v: 1,
      attemptId,
      expectedGeneration: before.selector.generation,
      ...(before.selector.generation === 0
        ? { expectedMembershipSha256: membershipSha256(before.selector.membership) }
        : {}),
      membership: desired
    })
  } catch (error) {
    const inspected = await inspectAdmissionSelector(post, attemptId)
    if (
      inspected.intent?.state === 'committed' &&
      exactSelector(inspected.selector, expected)
    ) {
      return { changed: true, selector: inspected.selector, recovered: true }
    }
    if (
      inspected.intent?.state === 'unchanged' &&
      exactSelector(inspected.selector, before.selector)
    ) {
      throw new Error('admission selector apply remained unchanged after an ambiguous response', {
        cause: error
      })
    }
    throw new Error('admission selector apply diverged after an ambiguous response', {
      cause: error
    })
  }
  const applied = assertSelector(result.selector)
  if (!exactSelector(applied, expected)) {
    throw new Error('admission selector apply returned unexpected membership')
  }
  const verified = await inspectAdmissionSelector(post, attemptId)
  if (
    verified.intent?.state !== 'committed' ||
    !exactSelector(verified.selector, expected)
  ) {
    throw new Error('admission selector commit could not be verified')
  }
  return { changed: result.changed === true, selector: verified.selector }
}

export async function addExactMigrationCells(post, input, options = {}) {
  const cells = normalizeMigrationCells(input.cells)
  const attemptId = input.attemptId
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(attemptId ?? '')) {
    throw new Error('migration cell registration requires an exact attempt ID')
  }
  const before = await inspectAdmissionSelector(post, attemptId)
  let expectedGeneration
  let expectedMembership
  if (before.intent) {
    expectedGeneration = before.intent.expectedGeneration
    expectedMembership = normalizeMembership(before.intent.membership)
  } else {
    if (before.selector.generation < 1) {
      throw new Error('admission selector boundary is not active')
    }
    if (
      options.expectedCurrentSelector &&
      !exactSelector(before.selector, options.expectedCurrentSelector)
    ) {
      throw new Error('admission selector changed before cell registration')
    }
    expectedGeneration = before.selector.generation
    expectedMembership = membershipWithMigrationCells(before.selector.membership, cells)
  }
  const expected = {
    generation: expectedGeneration + 1,
    membership: expectedMembership
  }
  let result
  try {
    result = await post('/v1/admin/admission-selector/add-migration-cells', {
      v: 1,
      attemptId,
      expectedGeneration,
      cells
    })
  } catch (error) {
    const inspected = await inspectAdmissionSelector(post, attemptId)
    if (
      !before.intent &&
      inspected.intent?.state === 'committed' &&
      exactSelector(inspected.selector, expected)
    ) {
      return { changed: true, selector: inspected.selector, recovered: true }
    }
    throw new Error('migration cell registration did not commit exactly', { cause: error })
  }
  const applied = assertSelector(result.selector)
  if (!exactSelector(applied, expected)) {
    throw new Error('migration cell registration returned unexpected membership')
  }
  const verified = await inspectAdmissionSelector(post, attemptId)
  if (verified.intent?.state !== 'committed' || !exactSelector(verified.selector, expected)) {
    throw new Error('migration cell registration commit could not be verified')
  }
  return { changed: result.changed === true, selector: verified.selector }
}

export async function transitionAdmissionSelector(post, states, options = {}) {
  const current = await inspectAdmissionSelector(post)
  if (current.selector.generation < 1) {
    throw new Error('admission selector boundary is not active')
  }
  return await applyExactAdmissionSelector(
    post,
    membershipWithStates(current.selector, states),
    options
  )
}

export function selectorCellState(selector, cellId) {
  if (selector.membership.existingOnly.includes(cellId)) return 'existing-only'
  if (selector.membership.migrationOnly.includes(cellId)) return 'migration-only'
  if (selector.membership.general.includes(cellId)) return 'general'
  throw new Error(`selector does not contain ${cellId}`)
}
