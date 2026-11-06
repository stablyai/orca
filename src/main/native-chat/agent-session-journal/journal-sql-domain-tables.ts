import type { JournalSqlScope } from './journal-sql-scope'
import { journalSqlInputEntity } from './journal-sql-input-entities'
import { journalSqlPrimitiveFact } from './journal-sql-primitive-facts'
import { journalSqlMemberIds } from './journal-sql-membership-tables'

export class JournalSqlDomainTables {
  constructor(private readonly scope: JournalSqlScope) {}

  for(collection: string) {
    return (
      journalSqlInputEntity(this.scope, collection) ??
      journalSqlPrimitiveFact(this.scope, collection) ??
      journalSqlMemberIds(this.scope, collection)
    )
  }
}
