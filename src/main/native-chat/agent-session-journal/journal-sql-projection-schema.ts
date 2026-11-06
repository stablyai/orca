import { journalSqlIndexSchema } from './journal-sql-index-schema'
import { journalSqlValueSchema } from './journal-sql-value-schema'
import { journalSqlScalarSchema } from './journal-sql-scalars'
import { journalSqlItemSchema } from './journal-sql-item-schema'
import { journalSqlQuerySchema } from './journal-sql-query-schema'
import { journalSqlPauseSchema } from './journal-sql-pause-marks'
import { journalSqlMetaSchema } from './journal-sql-meta'
import { journalSqlInputEntitySchema } from './journal-sql-input-entity-schema'
import { journalSqlDomainCounterSchema } from './journal-sql-domain-counter-schema'
import { journalSqlPrimitiveFactSchema } from './journal-sql-primitive-fact-schema'
import { journalSqlInputObservationSchema } from './journal-sql-input-observation-schema'
import { journalSqlMembershipSchema } from './journal-sql-membership-schema'
import { journalSqlInputEventSchema } from './journal-sql-input-event-schema'

export function journalSqlProjectionSchema(): string {
  return (
    journalSqlIndexSchema() +
    journalSqlValueSchema() +
    journalSqlScalarSchema() +
    journalSqlItemSchema() +
    journalSqlDomainCounterSchema() +
    journalSqlInputEntitySchema() +
    journalSqlPrimitiveFactSchema() +
    journalSqlInputObservationSchema() +
    journalSqlMembershipSchema() +
    journalSqlInputEventSchema() +
    journalSqlQuerySchema() +
    journalSqlPauseSchema() +
    journalSqlMetaSchema()
  )
}
