import { z } from 'zod'
import type { OrchestrationDb } from '../db'
import type { DispatchCreator } from '../db/dispatch-depth'
import { createDispatchCreatorEvaluation } from '../db/dispatch-creator-evaluation'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  paneKeyMatchSuffix
} from '../db/pane-key-match'
import { potentiallyLiveRemoteAttachmentSql } from '../db/federation/remote-attachment-liveness'

const nullable = z.string().nullable()
const Dispatch = z.object({
  id: z.string(),
  run_id: z.string(),
  creator_dispatch_id: nullable,
  follow_up_of_dispatch_id: nullable,
  process_incarnation: nullable,
  host_scope: nullable,
  creator_handle: nullable,
  creator_pane_key: nullable,
  assignee_handle: nullable,
  assignee_pane_key: nullable,
  depth: z.number()
})
const Resource = z.object({
  id: z.string(),
  owner_dispatch_id: z.string(),
  prior_owner_dispatch_ids: z.string()
})
const Remote = z.object({
  dispatch_id: z.string(),
  depth: z.number(),
  pane_key: nullable,
  process_incarnation: nullable,
  state: z.enum(['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'])
})
const Run = z.object({ id: z.string(), legacy: z.number() })
const columns = Object.keys(Dispatch.shape).join(', ')

/** Only complete raw values/null survive in the disposable generation; throwing misses stay uncovered. */
export function createCrewFollowUpAuthorityInputs(db: OrchestrationDb) {
  const memo = <T>() => {
    const rows = new Map<string, T>()
    return (key: string, read: () => T): T => {
      if (!rows.has(key)) {
        rows.set(key, read())
      }
      return rows.get(key)!
    }
  }
  const dispatches = memo<z.infer<typeof Dispatch> | null>()
  const resources = memo<z.infer<typeof Resource> | null>()
  const cohorts = memo<z.infer<typeof Resource>[]>()
  const runs = memo<z.infer<typeof Run> | null>()
  const locals = memo<z.infer<typeof Dispatch> | null>()
  const remotes = memo<z.infer<typeof Remote>[]>()
  const dispatch = (id: string) =>
    dispatches(
      id,
      () =>
        Dispatch.nullish().parse(
          db.db.prepare(`SELECT ${columns} FROM dispatch_contexts WHERE id = ?`).get(id)
        ) ?? null
    ) ?? undefined
  const local = (creator: Exclude<DispatchCreator, { kind: 'system' }>) =>
    locals(JSON.stringify(creator), () => {
      const first = (where: string, key: string) =>
        Dispatch.nullish().parse(
          db.db
            .prepare(
              `SELECT ${columns} FROM dispatch_contexts WHERE ${where} AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1`
            )
            .get(key)
        )
      if (creator.kind === 'session') {
        return first('assignee_orca_session_id = ?', creator.orcaSessionId) ?? null
      }
      const handle = first('assignee_handle = ?', creator.handle)
      if (handle || !creator.paneKey) {
        return handle ?? null
      }
      const exact = first('assignee_pane_key = ?', creator.paneKey)
      return (
        exact ??
        (parsePaneKey(creator.paneKey)
          ? first(
              `assignee_pane_key IS NOT NULL AND instr(assignee_pane_key, ':') > 1 AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?`,
              paneKeyMatchSuffix(creator.paneKey)
            )
          : null) ??
        null
      )
    }) ?? undefined
  const remote = (creator: DispatchCreator) => {
    if (creator.kind !== 'terminal' || !creator.paneKey || !creator.processIncarnation) {
      return []
    }
    const pane = creator.paneKey
    return remotes(JSON.stringify([pane, creator.processIncarnation]), () => {
      const read = (where: string, key: string) =>
        Remote.array().parse(
          db.db
            .prepare(
              `SELECT dispatch_id, depth, pane_key, process_incarnation, state FROM remote_dispatch_attachments WHERE ${where} AND ${potentiallyLiveRemoteAttachmentSql()}`
            )
            .all(key)
        )
      const exact = read('pane_key = ?', pane)
      const suffix = parsePaneKey(pane)
        ? read(
            `pane_key IS NOT NULL AND instr(pane_key, ':') > 1 AND ${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL} = ?`,
            paneKeyMatchSuffix(pane)
          )
        : []
      return [...new Map([...exact, ...suffix].map((row) => [row.dispatch_id, row])).values()]
    })
  }
  return {
    dispatch,
    taskDispatch: (id: string) => {
      throw new Error(`Crew follow-up unexpectedly requested Task ${id}`)
    },
    owned: (id: string) =>
      resources(
        id,
        () =>
          Resource.nullish().parse(
            db.db
              .prepare(
                'SELECT id, owner_dispatch_id, prior_owner_dispatch_ids FROM worker_terminal_resources WHERE owner_dispatch_id = ?'
              )
              .get(id)
          ) ?? null
      ) ?? undefined,
    cohort: (incarnation: string, host: string | null) =>
      cohorts(JSON.stringify([incarnation, host]), () =>
        Resource.array().parse(
          db.db
            .prepare(
              'SELECT id, owner_dispatch_id, prior_owner_dispatch_ids FROM worker_terminal_resources WHERE process_incarnation = ? AND host_scope IS ?'
            )
            .all(incarnation, host)
        )
      ),
    run: (id: string) =>
      runs(
        id,
        () =>
          Run.nullish().parse(db.db.prepare('SELECT id, legacy FROM runs WHERE id = ?').get(id)) ??
          null
      ) ?? undefined,
    caller: (creator: DispatchCreator) =>
      createDispatchCreatorEvaluation(creator, {
        local: () => (creator.kind === 'system' ? undefined : local(creator)),
        remote: () => remote(creator)
      })
  }
}
