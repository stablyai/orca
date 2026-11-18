// A bot's chats tree re-reads only the Dispatches a change touched, by id, instead of its whole history.
import type { OrchestrationDb } from '../orchestration-db'
import {
  DISPATCH_LINK_COLUMNS,
  DISPATCH_LINK_JOINS,
  dispatchLinkRows,
  type DispatchCreatorLink
} from './dispatch-context-store'

const DISPATCH_LINKS_BY_IDS_SQL = `
  SELECT ${DISPATCH_LINK_COLUMNS} FROM dispatch_contexts d ${DISPATCH_LINK_JOINS}
  WHERE d.id IN (SELECT value FROM json_each(?1))`

/** These Dispatches, as `listDispatchLinksCreatedByAny` reads them; an unknown id is left out. */
export function listDispatchLinksByIds(
  this: OrchestrationDb,
  dispatchIds: readonly string[]
): DispatchCreatorLink[] {
  return dispatchIds.length === 0
    ? []
    : dispatchLinkRows(this.db.prepare(DISPATCH_LINKS_BY_IDS_SQL).all(JSON.stringify(dispatchIds)))
}

export type DispatchLinksByIdMethods = { listDispatchLinksByIds: typeof listDispatchLinksByIds }

export function attachDispatchLinksById(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { listDispatchLinksByIds })
}
