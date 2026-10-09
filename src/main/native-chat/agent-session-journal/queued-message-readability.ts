// SQLite accepts JSON text in BLOBs and ignores NUL suffixes that JSON.parse rejects.
export const READABLE_QUEUED_MESSAGE_BODY =
  "typeof(body_json) = 'text' AND instr(body_json, char(0)) = 0 AND json_valid(body_json)"

export const READABLE_QUEUED_MESSAGE = `state IN ('waiting', 'returned', 'dispatched', 'withdrawn') AND ${READABLE_QUEUED_MESSAGE_BODY}`

export const READABLE_UNSETTLED_QUEUED_MESSAGE = `state IN ('waiting', 'returned') AND ${READABLE_QUEUED_MESSAGE}`
