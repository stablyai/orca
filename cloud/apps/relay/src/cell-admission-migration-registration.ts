import {
  isRelayCellConnectionHardCap,
  RELAY_DEFAULT_REGION,
  RELAY_REGIONS,
  relayCellAdmissionBounds,
  type RelayCellConnectionHardCap,
  type RelayRegion
} from '@orca-cloud/relay-contract'
import {
  decodeMembership,
  encodeMembership,
  lockedSelector,
  normalizeMembership,
  requireSelectorMatchesAdmission,
  type CellAdmissionMembership,
  type CellAdmissionSelector
} from './cell-admission-selector.js'
import type { RelayDatabase, SqlRow } from './database.js'

export type MigrationCellRegistration = {
  id: string
  url: string
  capacityRequests: number
  connectionHardCap: RelayCellConnectionHardCap
  connectionUnobservedBound: number
  region?: RelayRegion
}

type NormalizedMigrationCellRegistration = MigrationCellRegistration & { region: RelayRegion }

type AddMigrationCellsInput = {
  attemptId: string
  expectedGeneration: number
  cells: MigrationCellRegistration[]
}

const SELECTOR_ID = 'general'

export class RelayMigrationCellRegistrar {
  constructor(
    private readonly database: RelayDatabase,
    private readonly now: () => number
  ) {}

  async add(input: AddMigrationCellsInput): Promise<{
    changed: boolean
    selector: CellAdmissionSelector
  }> {
    validateAttempt(input)
    const cells = normalizeMigrationCells(input.cells)
    const encodedCells = encodeCells(cells)
    return await this.database.transaction(async (transaction) => {
      const inventory = await transaction.queryLocked(
        `SELECT * FROM relay_cells ORDER BY cell_id ASC`
      )
      const selector = await lockedSelector(transaction)
      await requireSelectorMatchesAdmission(transaction, selector)
      const intent = (
        await transaction.queryLocked(
          `SELECT * FROM relay_admission_selector_intents WHERE attempt_id = ?`,
          [input.attemptId]
        )
      )[0]
      const addition = (
        await transaction.queryLocked(
          `SELECT * FROM relay_admission_selector_cell_additions WHERE attempt_id = ?`,
          [input.attemptId]
        )
      )[0]
      if (Boolean(intent) !== Boolean(addition)) {
        throw new Error('admission_selector_attempt_mismatch')
      }
      if (intent && addition) {
        const membership = decodeMembership(text(intent, 'membership_json'))
        if (
          integer(intent, 'expected_generation') !== input.expectedGeneration ||
          integer(intent, 'intended_generation') !== input.expectedGeneration + 1 ||
          text(addition, 'cells_json') !== encodedCells ||
          encodeMembership(membership) !==
            encodeMembership(
              membershipAfterAddition(
                decodeMembership(text(intent, 'previous_membership_json')),
                cells
              )
            )
        ) {
          throw new Error('admission_selector_attempt_mismatch')
        }
        if (
          selector.generation === input.expectedGeneration + 1 &&
          selector.attemptId === input.attemptId &&
          encodeMembership(selector.membership) === encodeMembership(membership)
        ) {
          await requireExactAddedCells(transaction, inventory, cells)
          return { changed: false, selector }
        }
        throw new Error('admission_selector_generation_mismatch')
      }
      if (selector.generation < 1) {
        throw new Error('admission_selector_boundary_inactive')
      }
      if (selector.generation !== input.expectedGeneration) {
        throw new Error('admission_selector_generation_mismatch')
      }
      const inventoryIds = new Set(inventory.map((row) => text(row, 'cell_id')))
      const inventoryUrls = new Set(inventory.map((row) => text(row, 'cell_url')))
      if (cells.some((cell) => inventoryIds.has(cell.id) || inventoryUrls.has(cell.url))) {
        throw new Error('admission_selector_cell_already_exists')
      }
      return await this.commit(transaction, input, cells, selector, encodedCells)
    })
  }

  private async commit(
    transaction: RelayDatabase,
    input: AddMigrationCellsInput,
    cells: NormalizedMigrationCellRegistration[],
    selector: CellAdmissionSelector,
    encodedCells: string
  ): Promise<{ changed: true; selector: CellAdmissionSelector }> {
    const membership = membershipAfterAddition(selector.membership, cells)
    const encodedMembership = encodeMembership(membership)
    const now = this.now()
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
        encodedMembership,
        now
      ]
    )
    await transaction.query(
      `INSERT INTO relay_admission_selector_cell_additions (attempt_id, cells_json)
       VALUES (?, ?)`,
      [input.attemptId, encodedCells]
    )
    for (const cell of cells) await insertCell(transaction, cell, now)
    const intendedGeneration = input.expectedGeneration + 1
    const updated = await transaction.query(
      `UPDATE relay_admission_selectors
       SET generation = ?, attempt_id = ?, membership_json = ?, updated_at = ?
       WHERE selector_id = ? AND generation = ?`,
      [
        intendedGeneration,
        input.attemptId,
        encodedMembership,
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
  }
}

function encodeCells(cells: NormalizedMigrationCellRegistration[]): string {
  return JSON.stringify(
    cells.map((cell) =>
      cell.region === RELAY_DEFAULT_REGION
        ? {
            id: cell.id,
            url: cell.url,
            capacityRequests: cell.capacityRequests,
            connectionHardCap: cell.connectionHardCap,
            connectionUnobservedBound: cell.connectionUnobservedBound
          }
        : cell
    )
  )
}

async function insertCell(
  transaction: RelayDatabase,
  cell: NormalizedMigrationCellRegistration,
  now: number
): Promise<void> {
  await transaction.query(
    `INSERT INTO relay_cells
     (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
      observed_requests, last_heartbeat_at, updated_at)
     VALUES (?, ?, 1, ?, 0, 0, ?, ?)`,
    [cell.id, cell.url, cell.capacityRequests, now, now]
  )
  await transaction.query(
    `INSERT INTO relay_cell_regions (cell_id, region) VALUES (?, ?)`,
    [cell.id, cell.region]
  )
  await transaction.query(
    `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
     VALUES (?, 'migration-only', ?)`,
    [cell.id, now]
  )
  await transaction.query(
    `INSERT INTO relay_cell_connection_limits
     (cell_id, hard_cap, unobserved_bound, updated_at)
     VALUES (?, ?, ?, ?)`,
    [cell.id, cell.connectionHardCap, cell.connectionUnobservedBound, now]
  )
}

function normalizeMigrationCells(
  input: MigrationCellRegistration[]
): NormalizedMigrationCellRegistration[] {
  if (input.length === 0 || input.length > 128) {
    throw new Error('invalid_admission_selector_cells')
  }
  const cells = input
    .map((cell) => ({ ...cell, region: cell.region ?? RELAY_DEFAULT_REGION }))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (
    new Set(cells.map(({ id }) => id)).size !== cells.length ||
    new Set(cells.map(({ url }) => url)).size !== cells.length
  ) {
    throw new Error('admission_selector_duplicate_cell')
  }
  for (const cell of cells) validateMigrationCell(cell)
  return cells
}

function validateMigrationCell(cell: NormalizedMigrationCellRegistration): void {
  if (
    cell.id.length === 0 ||
    cell.id.length > 128 ||
    cell.url.length === 0 ||
    cell.url.length > 2_048 ||
    !Number.isSafeInteger(cell.capacityRequests) ||
    cell.capacityRequests <= 0 ||
    cell.capacityRequests > 100_000 ||
    !isRelayCellConnectionHardCap(cell.connectionHardCap) ||
    !Number.isSafeInteger(cell.connectionUnobservedBound) ||
    cell.connectionUnobservedBound < 0 ||
    cell.connectionUnobservedBound >
      relayCellAdmissionBounds(cell.connectionHardCap).maxUnobservedBound ||
    !RELAY_REGIONS.includes(cell.region)
  ) {
    throw new Error('invalid_admission_selector_cell')
  }
}

function membershipAfterAddition(
  membership: CellAdmissionMembership,
  cells: NormalizedMigrationCellRegistration[]
): CellAdmissionMembership {
  return normalizeMembership({
    existingOnly: membership.existingOnly,
    migrationOnly: [...membership.migrationOnly, ...cells.map(({ id }) => id)],
    general: membership.general
  })
}

async function requireExactAddedCells(
  database: RelayDatabase,
  inventory: SqlRow[],
  cells: NormalizedMigrationCellRegistration[]
): Promise<void> {
  const byId = new Map(inventory.map((row) => [text(row, 'cell_id'), row]))
  for (const cell of cells) {
    const row = byId.get(cell.id)
    const admission = await admissionState(database, cell.id)
    const region = await cellRegion(database, cell.id)
    const limit = await connectionLimit(database, cell.id)
    if (
      !row ||
      text(row, 'cell_url') !== cell.url ||
      integer(row, 'enabled') !== 1 ||
      integer(row, 'capacity_requests') !== cell.capacityRequests ||
      region !== cell.region ||
      admission !== 'migration-only' ||
      !limit ||
      integer(limit, 'hard_cap') !== cell.connectionHardCap ||
      integer(limit, 'unobserved_bound') !== cell.connectionUnobservedBound
    ) {
      throw new Error('admission_selector_attempt_mismatch')
    }
  }
}

async function cellRegion(database: RelayDatabase, cellId: string): Promise<unknown> {
  return (
    await database.query(`SELECT region FROM relay_cell_regions WHERE cell_id = ?`, [cellId])
  )[0]?.region
}

async function admissionState(database: RelayDatabase, cellId: string): Promise<unknown> {
  return (
    await database.query(
      `SELECT admission_state FROM relay_cell_admission WHERE cell_id = ?`,
      [cellId]
    )
  )[0]?.admission_state
}

async function connectionLimit(
  database: RelayDatabase,
  cellId: string
): Promise<SqlRow | undefined> {
  return (
    await database.query(
      `SELECT hard_cap, unobserved_bound FROM relay_cell_connection_limits
       WHERE cell_id = ?`,
      [cellId]
    )
  )[0]
}

function validateAttempt(input: AddMigrationCellsInput): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.attemptId)) {
    throw new Error('invalid_admission_selector_attempt')
  }
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new Error('invalid_admission_selector_generation')
  }
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
