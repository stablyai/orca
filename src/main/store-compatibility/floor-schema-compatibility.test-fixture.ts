import type { StoreSchemaSnapshot } from './store-schema-snapshot.test-fixture'

export type FloorSchemaPolicy = {
  /** Stores whose newer user_version the floor build refuses or opens read-only. */
  userVersionMustMatch: boolean
  /** Triggers this build adds to tables the floor build writes; they fire inside its writes too. */
  reviewedFloorTableTriggers: Readonly<Record<string, string>>
  /** Tables the floor build inserts into without a column list, so their columns can't grow. */
  positionalInsertTables: readonly string[]
}

/** Changes that break a floor build writing this store after this build created or migrated it. */
export function floorSchemaViolations(
  floor: StoreSchemaSnapshot,
  current: StoreSchemaSnapshot,
  policy: FloorSchemaPolicy
): string[] {
  const violations: string[] = []
  if (
    policy.userVersionMustMatch
      ? current.userVersion !== floor.userVersion
      : current.userVersion < floor.userVersion
  ) {
    violations.push(`user_version ${floor.userVersion} -> ${current.userVersion}`)
  }
  for (const [table, floorTable] of Object.entries(floor.tables)) {
    const currentTable = current.tables[table]
    if (!currentTable) {
      violations.push(`table ${table} dropped`)
      continue
    }
    if (
      currentTable.withoutRowid !== floorTable.withoutRowid ||
      currentTable.strict !== floorTable.strict
    ) {
      violations.push(`table ${table} rowid or STRICT changed`)
    }
    const columns = new Map(currentTable.columns.map((column) => [column[0], column]))
    for (const floorColumn of floorTable.columns) {
      const column = columns.get(floorColumn[0])
      if (!column) {
        violations.push(`column ${table}.${floorColumn[0]} dropped`)
      } else if (JSON.stringify(column) !== JSON.stringify(floorColumn)) {
        violations.push(`column ${table}.${floorColumn[0]} changed`)
      }
    }
    // Generated columns take no positional values.
    const columnOrder = (shape: typeof floorTable): string =>
      shape.columns
        .filter((column) => column[5] < 2)
        .map((column) => column[0])
        .join(',')
    if (
      policy.positionalInsertTables.includes(table) &&
      columnOrder(currentTable) !== columnOrder(floorTable)
    ) {
      violations.push(
        `columns of ${table} added or moved; the floor build inserts into it by position`
      )
    }
    const floorColumnNames = new Set(floorTable.columns.map((column) => column[0]))
    for (const [name, , notNull, defaultSql] of currentTable.columns) {
      if (
        !floorColumnNames.has(name) &&
        notNull &&
        (defaultSql ?? 'NULL').toUpperCase() === 'NULL'
      ) {
        violations.push(`column ${table}.${name} added NOT NULL without a default`)
      }
    }
    if (JSON.stringify(currentTable.checks) !== JSON.stringify(floorTable.checks)) {
      violations.push(`CHECK constraints on ${table} changed`)
    }
    if (JSON.stringify(currentTable.foreignKeys) !== JSON.stringify(floorTable.foreignKeys)) {
      violations.push(`foreign keys on ${table} changed`)
    }
    for (const key of currentTable.uniqueKeys) {
      if (!floorTable.uniqueKeys.includes(key)) {
        violations.push(`unique key (${key}) added to ${table}`)
      }
    }
  }
  for (const [name, floorIndex] of Object.entries(floor.indexes)) {
    const index = current.indexes[name]
    if (!index) {
      violations.push(`index ${name} dropped`)
    } else if (index.sql !== floorIndex.sql) {
      violations.push(`index ${name} changed; give the new definition a new name`)
    }
  }
  for (const [name, floorTrigger] of Object.entries(floor.triggers)) {
    const trigger = current.triggers[name]
    if (!trigger) {
      violations.push(`trigger ${name} dropped`)
    } else if (trigger.sql !== floorTrigger.sql) {
      violations.push(`trigger ${name} body changed; give the new body a new name`)
    }
  }
  for (const [name, floorView] of Object.entries(floor.views)) {
    if (current.views[name] !== floorView) {
      violations.push(`view ${name} ${current.views[name] === undefined ? 'dropped' : 'changed'}`)
    }
  }
  for (const [name, trigger] of Object.entries(current.triggers)) {
    if (floor.triggers[name] || !floor.tables[trigger.table]) {
      continue
    }
    if (policy.reviewedFloorTableTriggers[name] !== trigger.sql) {
      violations.push(`trigger ${name} on ${trigger.table} is not in the reviewed list`)
    }
  }
  return violations
}
