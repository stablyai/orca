import { READABLE_UNSETTLED_QUEUED_MESSAGE } from './queued-message-readability'

// Why: an expression index follows old and new writers without another persisted source truth.
export const QUEUED_MESSAGE_SOURCE_SQL = `CASE
  WHEN NOT json_valid(body_json) THEN 'unknown'
  WHEN json_type(body_json, '$.from') IS NULL THEN 'person'
  WHEN json_type(body_json, '$.from') = 'object'
    AND json_type(body_json, '$.from.kind') = 'text' THEN 'agent'
  ELSE 'unknown' END`

// Same text as the partial indexes' WHERE, so the planner can use them.
export const QUEUED_MESSAGE_UNSETTLED_SQL = READABLE_UNSETTLED_QUEUED_MESSAGE
