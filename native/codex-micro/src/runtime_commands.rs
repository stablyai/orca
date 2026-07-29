use serde_json::Value;
use std::collections::HashMap;

pub const STATUS_METHOD: &str = "device.status";
pub const WRITE_METHODS: &[&str] = &["v.oai.rgbcfg", "v.oai.thstatus"];

pub fn is_write_method(method: &str) -> bool {
    WRITE_METHODS.contains(&method)
}

/// Issues strictly increasing request IDs, starting at 1.
#[derive(Debug, Default)]
pub struct RequestIdGenerator {
    next: u64,
}

impl RequestIdGenerator {
    pub fn new() -> Self {
        Self { next: 1 }
    }

    pub fn next_id(&mut self) -> u64 {
        let id = self.next.max(1);
        self.next = id + 1;
        id
    }
}

pub fn build_command(method: &str, params: Value, id: u64) -> Value {
    serde_json::json!({ "method": method, "params": params, "id": id })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckOutcome {
    Matched,
    Indeterminate,
}

/// Classifies a leftover response chunk against a pending request id and
/// method. A chunk that isn't valid JSON, doesn't carry the matching id,
/// doesn't carry the matching method, or doesn't report `result.ok == 1` is
/// indeterminate — the caller must never resend on this outcome.
pub fn classify_ack(pending_id: u64, method: &str, chunk: &[u8]) -> AckOutcome {
    let Ok(value) = serde_json::from_slice::<Value>(chunk) else {
        return AckOutcome::Indeterminate;
    };
    let matches_id = value.get("id").and_then(Value::as_u64) == Some(pending_id);
    let matches_method = value.get("method").and_then(Value::as_str) == Some(method);
    let ok = value
        .get("result")
        .and_then(|result| result.get("ok"))
        .and_then(Value::as_u64)
        == Some(1);
    if matches_id && matches_method && ok {
        AckOutcome::Matched
    } else {
        AckOutcome::Indeterminate
    }
}

/// Suppresses a write when the full output snapshot for a method is
/// byte-for-byte identical to the last one sent for that method.
#[derive(Debug, Default)]
pub struct SnapshotDeduplicator {
    last_sent: HashMap<String, Value>,
}

impl SnapshotDeduplicator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` and records `params` as the new baseline when the
    /// snapshot differs from the last one sent for `method`; returns
    /// `false` without recording anything when it is a duplicate.
    pub fn should_send(&mut self, method: &str, params: &Value) -> bool {
        if self.is_duplicate(method, params) {
            return false;
        }
        self.record(method, params);
        true
    }

    pub fn is_duplicate(&self, method: &str, params: &Value) -> bool {
        self.last_sent.get(method) == Some(params)
    }

    pub fn record(&mut self, method: &str, params: &Value) {
        self.last_sent.insert(method.to_string(), params.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_increase_monotonically_from_one() {
        let mut generator = RequestIdGenerator::new();
        let ids: Vec<u64> = (0..5).map(|_| generator.next_id()).collect();
        assert_eq!(ids, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn classifies_a_matching_ok_ack_as_matched() {
        let chunk = br#"{"result":{"ok":1},"id":42,"method":"v.oai.rgbcfg"}"#;
        assert_eq!(classify_ack(42, "v.oai.rgbcfg", chunk), AckOutcome::Matched);
    }

    #[test]
    fn classifies_a_mismatched_id_as_indeterminate() {
        let chunk = br#"{"result":{"ok":1},"id":41,"method":"v.oai.rgbcfg"}"#;
        assert_eq!(
            classify_ack(42, "v.oai.rgbcfg", chunk),
            AckOutcome::Indeterminate
        );
    }

    #[test]
    fn classifies_a_mismatched_method_as_indeterminate() {
        let chunk = br#"{"result":{"ok":1},"id":42,"method":"v.oai.thstatus"}"#;
        assert_eq!(
            classify_ack(42, "v.oai.rgbcfg", chunk),
            AckOutcome::Indeterminate
        );
    }

    #[test]
    fn classifies_malformed_bytes_as_indeterminate() {
        assert_eq!(
            classify_ack(42, "v.oai.rgbcfg", b"not json"),
            AckOutcome::Indeterminate
        );
    }

    #[test]
    fn deduplicates_identical_full_snapshots() {
        let mut dedup = SnapshotDeduplicator::new();
        let params = serde_json::json!({"ambient": {"e": 1, "c": "0xffffff"}});

        assert!(dedup.should_send("v.oai.rgbcfg", &params));
        assert!(
            !dedup.should_send("v.oai.rgbcfg", &params),
            "identical snapshot must be suppressed"
        );

        let changed = serde_json::json!({"ambient": {"e": 0, "c": "0x000000"}});
        assert!(
            dedup.should_send("v.oai.rgbcfg", &changed),
            "changed snapshot must send"
        );
    }

    #[test]
    fn only_the_captured_methods_are_writes() {
        assert!(is_write_method("v.oai.rgbcfg"));
        assert!(is_write_method("v.oai.thstatus"));
        assert!(!is_write_method("device.status"));
        assert!(!is_write_method("v.oai.hid"));
    }
}
