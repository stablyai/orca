import type { SessionSearchCatalogRow } from './session-search-catalog-types'

export type SessionSearchValueRow = Omit<SessionSearchCatalogRow, 'value'> & { data: unknown }

export function sessionSearchValueRow(row: SessionSearchCatalogRow): SessionSearchValueRow {
  const { value, ...fields } = row
  return { ...fields, data: JSON.parse(value) }
}
