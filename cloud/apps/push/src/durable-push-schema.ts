export const DURABLE_PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_dismissed_events (
  host_fingerprint TEXT NOT NULL,
  notification_epoch TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  notification_seq BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(host_fingerprint, notification_epoch, notification_id)
);
CREATE INDEX IF NOT EXISTS push_dismissed_retention ON push_dismissed_events(created_at);
CREATE TABLE IF NOT EXISTS push_events (
  event_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_events_quota ON push_events(host_fingerprint, kind, created_at);
CREATE TABLE IF NOT EXISTS push_event_recipients (
  event_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(event_id, registration_id)
);
CREATE TABLE IF NOT EXISTS push_delivery_batches (
  batch_id TEXT PRIMARY KEY,
  host_fingerprint TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  lease_token TEXT,
  lease_until BIGINT NOT NULL,
  attempts BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_events_retention ON push_events(created_at);
CREATE INDEX IF NOT EXISTS push_recipients_retention ON push_event_recipients(created_at);
CREATE INDEX IF NOT EXISTS push_batches_expiry ON push_delivery_batches(expires_at);
CREATE INDEX IF NOT EXISTS push_batches_due ON push_delivery_batches(state, due_at);
CREATE INDEX IF NOT EXISTS push_batches_registration ON push_delivery_batches(registration_id, state);
`
