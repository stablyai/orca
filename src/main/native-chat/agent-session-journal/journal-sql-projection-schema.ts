import { journalSqlIndexSchema } from './journal-sql-index-schema'
import { journalSqlValueSchema } from './journal-sql-value-schema'
import { journalSqlScalarSchema } from './journal-sql-scalars'
import { journalSqlItemSchema } from './journal-sql-item-schema'
import { journalSqlQuerySchema } from './journal-sql-query-schema'
import { journalSqlPauseSchema } from './journal-sql-pause-marks'
import { journalSqlMetaSchema } from './journal-sql-meta'

export function journalSqlProjectionSchema(): string {
  return (
    journalSqlIndexSchema() +
    journalSqlValueSchema() +
    journalSqlScalarSchema() +
    journalSqlItemSchema() +
    journalSqlQuerySchema() +
    journalSqlPauseSchema() +
    journalSqlMetaSchema()
  )
}
