import { createHash } from 'node:crypto'
import type { RelayDatabase, SqlRow } from './database.js'

export const CELL_ADMISSION_STATES = [
  'existing-only',
  'migration-only',
  'general'
] as const

export type CellAdmissionState = (typeof CELL_ADMISSION_STATES)[number]

export type CellAdmissionMembership = {
  existingOnly: string[]
  migrationOnly: string[]
  general: string[]
}

export type CellAdmissionSelector = {
  generation: number
  attemptId: string | null
  membership: CellAdmissionMembership
}

export type CellAdmissionSelectorInspection = {
  selector: CellAdmissionSelector
  intent: null | {
    attemptId: string
    expectedGeneration: number
    intendedGeneration: number
    previousMembership: CellAdmissionMembership
    membership: CellAdmissionMembership
    state: 'unchanged' | 'committed' | 'diverged'
  }
}

type ApplySelectorInput = {
  attemptId: string
  expectedGeneration: number
  expectedMembershipSha256?: string
  membership: CellAdmissionMembership
}

const SELECTOR_ID = 'general'

export function stateFromEnabled(enabled: boolean): CellAdmissionState {
  return enabled ? 'general' : 'existing-only'
}

export function enabledForState(state: CellAdmissionState): number {
  return state === 'existing-only' ? 0 : 1
}

export function parseCellAdmissionState(value: string): CellAdmissionState {
  if (!CELL_ADMISSION_STATES.includes(value as CellAdmissionState)) {
    throw new Error('invalid_cell_admission_state')
  }
  return value as CellAdmissionState
}

export async function ensureCellAdmission(
  transaction: RelayDatabase,
  cellId: string,
  fallback: CellAdmissionState,
  now: number
): Promise<void> {
  await transaction.query(
    `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
     VALUES (?, ?, ?) ON CONFLICT (cell_id) DO NOTHING`,
    [cellId, fallback, now]
  )
}

export async function cellAdmissionState(
  database: RelayDatabase,
  cellId: string
): Promise<CellAdmissionState> {
  const row = (
    await database.query(
      `SELECT admission_state FROM relay_cell_admission WHERE cell_id = ?`,
      [cellId]
    )
  )[0]
  if (!row) throw new Error('cell_admission_missing')
  return admissionState(row)
}

export async function cellAdmissionStates(
  database: RelayDatabase
): Promise<Map<string, CellAdmissionState>> {
  const rows = await database.query(
    `SELECT cell.cell_id, admission.admission_state
     FROM relay_cells cell
     LEFT JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
     ORDER BY cell.cell_id ASC`
  )
  return new Map(rows.map((row) => [text(row, 'cell_id'), admissionState(row)]))
}

export async function setCellAdmissionBeforeBoundary(
  transaction: RelayDatabase,
  cellId: string,
  state: CellAdmissionState,
  now: number
): Promise<void> {
  const cells = await transaction.queryLocked(
    `SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`
  )
  if (!cells.some((row) => text(row, 'cell_id') === cellId)) {
    throw new Error('cell_not_found')
  }
  if ((await lockedSelector(transaction)).generation > 0) {
    throw new Error('admission_selector_boundary_active')
  }
  const updated = await transaction.query(
    `UPDATE relay_cells
     SET updated_at = CASE WHEN enabled <> ? THEN ? ELSE updated_at END, enabled = ?
     WHERE cell_id = ?`,
    [enabledForState(state), now, enabledForState(state), cellId]
  )
  if (integer(updated[0]!, 'changes') !== 1) throw new Error('cell_not_found')
  await ensureCellAdmission(transaction, cellId, state, now)
  await transaction.query(
    `UPDATE relay_cell_admission
     SET updated_at = CASE WHEN admission_state <> ? THEN ? ELSE updated_at END,
         admission_state = ?
     WHERE cell_id = ?`,
    [state, now, state, cellId]
  )
  await synchronizeCellAdmissionBoundary(transaction, now)
}

export async function synchronizeCellAdmissionBoundary(
  transaction: RelayDatabase,
  now: number
): Promise<void> {
  const selector = await lockedSelector(transaction)
  if (selector.generation > 0) {
    await requireSelectorMatchesAdmission(transaction, selector)
    return
  }
  await transaction.query(
    `UPDATE relay_admission_selectors SET membership_json = ?, updated_at = ?
     WHERE selector_id = ? AND generation = 0`,
    [encodeMembership(await currentMembership(transaction)), now, SELECTOR_ID]
  )
}

export class RelayCellAdmissionSelector {
  constructor(
    private readonly database: RelayDatabase,
    private readonly now: () => number
  ) {}

  async apply(input: ApplySelectorInput): Promise<{
    changed: boolean
    selector: CellAdmissionSelector
  }> {
    const membership = normalizeMembership(input.membership)
    validateAttempt(input)
    const encoded = encodeMembership(membership)
    await this.persistIntent(input, membership, encoded)
    return await this.database.transaction(async (transaction) => {
      const cells = await transaction.queryLocked(
        `SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`
      )
      requireExactMembership(cells, membership)
      const selector = await lockedSelector(transaction)
      if (
        selector.generation === input.expectedGeneration + 1 &&
        selector.attemptId === input.attemptId &&
        encodeMembership(selector.membership) === encoded
      ) {
        return { changed: false, selector }
      }
      if (selector.generation !== input.expectedGeneration) {
        throw new Error('admission_selector_generation_mismatch')
      }
      requireExpectedMembership(selector, input.expectedMembershipSha256)
      await requireSelectorMatchesAdmission(transaction, selector)
      if (selector.generation > 0) {
        const nextNonExisting = new Set([...membership.migrationOnly, ...membership.general])
        if (selector.membership.existingOnly.some((cellId) => nextNonExisting.has(cellId))) {
          throw new Error('admission_selector_legacy_reenable')
        }
      }
      const now = this.now()
      for (const [state, cellIds] of membershipEntries(membership)) {
        for (const cellId of cellIds) {
          await transaction.query(
            `UPDATE relay_cell_admission
             SET updated_at = CASE WHEN admission_state <> ? THEN ? ELSE updated_at END,
                 admission_state = ?
             WHERE cell_id = ?`,
            [state, now, state, cellId]
          )
          await transaction.query(
            `UPDATE relay_cells
             SET updated_at = CASE WHEN enabled <> ? THEN ? ELSE updated_at END, enabled = ?
             WHERE cell_id = ?`,
            [enabledForState(state), now, enabledForState(state), cellId]
          )
        }
      }
      const intendedGeneration = input.expectedGeneration + 1
      const updated = await transaction.query(
        `UPDATE relay_admission_selectors
         SET generation = ?, attempt_id = ?, membership_json = ?, updated_at = ?
         WHERE selector_id = ? AND generation = ?`,
        [
          intendedGeneration,
          input.attemptId,
          encoded,
          now,
          SELECTOR_ID,
          input.expectedGeneration
        ]
      )
      if (integer(updated[0]!, 'changes') !== 1) {
        throw new Error('admission_selector_generation_mismatch')
      }
      await transaction.query(
        `UPDATE relay_admission_selector_intents SET committed_at = ?
         WHERE attempt_id = ?`,
        [now, input.attemptId]
      )
      return {
        changed: true,
        selector: {
          generation: intendedGeneration,
          attemptId: input.attemptId,
          membership
        }
      }
    })
  }

  async inspect(attemptId?: string): Promise<CellAdmissionSelectorInspection> {
    return await this.database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`)
      const selector = await lockedSelector(transaction)
      await requireSelectorMatchesAdmission(transaction, selector)
      if (!attemptId) return { selector, intent: null }
      const row = (
        await transaction.queryLocked(
          `SELECT * FROM relay_admission_selector_intents WHERE attempt_id = ?`,
          [attemptId]
        )
      )[0]
      if (!row) return { selector, intent: null }
      const membership = decodeMembership(text(row, 'membership_json'))
      const previousMembership = decodeMembership(text(row, 'previous_membership_json'))
      const intendedGeneration = integer(row, 'intended_generation')
      const committed =
        selector.generation === intendedGeneration &&
        selector.attemptId === attemptId &&
        encodeMembership(selector.membership) === encodeMembership(membership)
      const unchanged =
        selector.generation === integer(row, 'expected_generation') &&
        encodeMembership(selector.membership) === text(row, 'previous_membership_json')
      return {
        selector,
        intent: {
          attemptId,
          expectedGeneration: integer(row, 'expected_generation'),
          intendedGeneration,
          previousMembership,
          membership,
          state: committed ? 'committed' : unchanged ? 'unchanged' : 'diverged'
        }
      }
    })
  }

  private async persistIntent(
    input: ApplySelectorInput,
    membership: CellAdmissionMembership,
    encoded: string
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const cells = await transaction.queryLocked(
        `SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`
      )
      requireExactMembership(cells, membership)
      const selector = await lockedSelector(transaction)
      const existing = (
        await transaction.queryLocked(
          `SELECT * FROM relay_admission_selector_intents WHERE attempt_id = ?`,
          [input.attemptId]
        )
      )[0]
      if (existing) {
        const addition = (
          await transaction.queryLocked(
            `SELECT attempt_id FROM relay_admission_selector_cell_additions
             WHERE attempt_id = ?`,
            [input.attemptId]
          )
        )[0]
        if (
          addition ||
          integer(existing, 'expected_generation') !== input.expectedGeneration ||
          integer(existing, 'intended_generation') !== input.expectedGeneration + 1 ||
          text(existing, 'membership_json') !== encoded ||
          (input.expectedMembershipSha256 !== undefined &&
            membershipSha256(text(existing, 'previous_membership_json')) !==
              input.expectedMembershipSha256)
        ) {
          throw new Error('admission_selector_attempt_mismatch')
        }
        return
      }
      requireExpectedMembership(selector, input.expectedMembershipSha256)
      await transaction.query(
        `INSERT INTO relay_admission_selector_intents
         (attempt_id, expected_generation, intended_generation, previous_membership_json,
          membership_json, created_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [
          input.attemptId,
          input.expectedGeneration,
          input.expectedGeneration + 1,
          encodeMembership(selector.membership),
          encoded,
          this.now()
        ]
      )
    })
  }
}

function requireExpectedMembership(
  selector: CellAdmissionSelector,
  expectedSha256: string | undefined
): void {
  if (expectedSha256 === undefined) return
  if (
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    membershipSha256(encodeMembership(selector.membership)) !== expectedSha256
  ) {
    throw new Error('admission_selector_membership_mismatch')
  }
}

function membershipSha256(encoded: string): string {
  return createHash('sha256').update(encoded).digest('hex')
}

export async function lockedSelector(
  transaction: RelayDatabase
): Promise<CellAdmissionSelector> {
  let row = (
    await transaction.queryLocked(
      `SELECT * FROM relay_admission_selectors WHERE selector_id = ?`,
      [SELECTOR_ID]
    )
  )[0]
  if (!row) {
    const membership = await currentMembership(transaction)
    await transaction.query(
      `INSERT INTO relay_admission_selectors
       (selector_id, generation, attempt_id, membership_json, updated_at)
       VALUES (?, 0, NULL, ?, 0) ON CONFLICT (selector_id) DO NOTHING`,
      [SELECTOR_ID, encodeMembership(membership)]
    )
    row = (
      await transaction.queryLocked(
        `SELECT * FROM relay_admission_selectors WHERE selector_id = ?`,
        [SELECTOR_ID]
      )
    )[0]
  }
  if (!row) throw new Error('admission_selector_missing')
  return {
    generation: integer(row, 'generation'),
    attemptId: optionalText(row, 'attempt_id'),
    membership: decodeMembership(text(row, 'membership_json'))
  }
}

async function currentMembership(database: RelayDatabase): Promise<CellAdmissionMembership> {
  const rows = await database.query(
    `SELECT cell.cell_id, admission.admission_state
     FROM relay_cells cell
     LEFT JOIN relay_cell_admission admission ON admission.cell_id = cell.cell_id
     ORDER BY cell.cell_id ASC`
  )
  const membership: CellAdmissionMembership = {
    existingOnly: [],
    migrationOnly: [],
    general: []
  }
  for (const row of rows) membership[keyForState(admissionState(row))].push(text(row, 'cell_id'))
  return membership
}

export async function requireSelectorMatchesAdmission(
  database: RelayDatabase,
  selector: CellAdmissionSelector
): Promise<void> {
  const current = await currentMembership(database)
  if (encodeMembership(current) !== encodeMembership(selector.membership)) {
    throw new Error('admission_selector_membership_drift')
  }
}

export function normalizeMembership(
  input: CellAdmissionMembership
): CellAdmissionMembership {
  const membership = {
    existingOnly: [...input.existingOnly].sort(),
    migrationOnly: [...input.migrationOnly].sort(),
    general: [...input.general].sort()
  }
  const all = [...membership.existingOnly, ...membership.migrationOnly, ...membership.general]
  if (new Set(all).size !== all.length) throw new Error('admission_selector_duplicate_cell')
  return membership
}

function requireExactMembership(rows: SqlRow[], membership: CellAdmissionMembership): void {
  const expected = rows.map((row) => text(row, 'cell_id')).sort()
  const actual = [
    ...membership.existingOnly,
    ...membership.migrationOnly,
    ...membership.general
  ].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('admission_selector_incomplete_membership')
  }
}

function membershipEntries(
  membership: CellAdmissionMembership
): Array<[CellAdmissionState, string[]]> {
  return [
    ['existing-only', membership.existingOnly],
    ['migration-only', membership.migrationOnly],
    ['general', membership.general]
  ]
}

export function encodeMembership(membership: CellAdmissionMembership): string {
  return JSON.stringify(normalizeMembership(membership))
}

export function decodeMembership(value: string): CellAdmissionMembership {
  const parsed = JSON.parse(value) as Partial<CellAdmissionMembership>
  if (
    !Array.isArray(parsed.existingOnly) ||
    !Array.isArray(parsed.migrationOnly) ||
    !Array.isArray(parsed.general) ||
    [...parsed.existingOnly, ...parsed.migrationOnly, ...parsed.general].some(
      (cellId) => typeof cellId !== 'string'
    )
  ) {
    throw new Error('admission_selector_invalid_membership')
  }
  return normalizeMembership({
    existingOnly: parsed.existingOnly as string[],
    migrationOnly: parsed.migrationOnly as string[],
    general: parsed.general as string[]
  })
}

function admissionState(row: SqlRow): CellAdmissionState {
  return parseCellAdmissionState(text(row, 'admission_state'))
}

function keyForState(state: CellAdmissionState): keyof CellAdmissionMembership {
  if (state === 'existing-only') return 'existingOnly'
  if (state === 'migration-only') return 'migrationOnly'
  return 'general'
}

function validateAttempt(input: {
  attemptId: string
  expectedGeneration: number
  expectedMembershipSha256?: string
}): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.attemptId)) {
    throw new Error('invalid_admission_selector_attempt')
  }
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error('invalid_admission_selector_generation')
  }
  if (input.expectedGeneration === 0 && input.expectedMembershipSha256 === undefined) {
    throw new Error('admission_selector_membership_fingerprint_required')
  }
}

function optionalText(row: SqlRow, field: string): string | null {
  if (row[field] === null || row[field] === undefined) return null
  return text(row, field)
}

function integer(row: SqlRow, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new Error(`invalid integer field ${field}`)
  return value
}

function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`invalid text field ${field}`)
  return value
}
