export const LOCAL_QUIET_NOTICE_PREDICATE =
  "CASE WHEN json_valid(payload) THEN json_type(payload, '$.quietNotice') END = 'object'"
export const LOCAL_QUIET_NOTICE_DISPATCH = "json_extract(payload, '$.quietNotice.dispatchId')"
export const LOCAL_QUIET_NOTICE_TIME = "json_extract(payload, '$.quietNotice.observedAt')"

export const RELAY_QUIET_NOTICE_PAYLOAD = `CASE WHEN json_valid(payload) THEN
  CASE WHEN json_valid(json_extract(payload, '$.payload')) THEN json_extract(payload, '$.payload') END END`
export const RELAY_QUIET_NOTICE_PREDICATE = `direction = 'to_home' AND json_type(${RELAY_QUIET_NOTICE_PAYLOAD}, '$.quietNotice') = 'object'`
export const RELAY_QUIET_NOTICE_TIME = `json_extract(${RELAY_QUIET_NOTICE_PAYLOAD}, '$.quietNotice.observedAt')`

export const WORKER_QUIET_NOTICE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_messages_worker_quiet_latest
    ON messages(run_id, ${LOCAL_QUIET_NOTICE_DISPATCH}, ${LOCAL_QUIET_NOTICE_TIME} DESC)
    WHERE ${LOCAL_QUIET_NOTICE_PREDICATE};
  CREATE INDEX IF NOT EXISTS idx_relay_worker_quiet_latest
    ON federation_relay_items(dispatch_id, ${RELAY_QUIET_NOTICE_TIME} DESC)
    WHERE ${RELAY_QUIET_NOTICE_PREDICATE};
`
