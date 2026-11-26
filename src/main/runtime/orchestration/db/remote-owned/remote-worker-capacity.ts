import { ABANDONED_HERE } from './remote-dispatch-records'

/** Count live attempts and pre-answer holds for the current remote_run_links row (aliased as link). */
export const ACTIVE_REMOTE_WORKERS_FOR_LINK_SQL = `(
  (SELECT COUNT(*) FROM remote_placements placement
   WHERE placement.conversation_id = link.conversation_id AND placement.state = 'reserved')
  +
  (SELECT COUNT(*) FROM remote_dispatches dispatch
   WHERE dispatch.conversation_id = link.conversation_id
     AND dispatch.task_settled_here <> ${ABANDONED_HERE}
     AND (dispatch.worker_state NOT IN ('succeeded', 'failed', 'stopped', 'abandoned')
       OR (dispatch.worker_state IS NULL AND dispatch.status IN ('pending', 'dispatched'))))
)`
