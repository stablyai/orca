use crate::device::{send_state_command, RuntimeGate, SendOutcome};
use crate::report6::Report6Parser;
use crate::runtime_commands::{AckOutcome, RequestIdGenerator, SnapshotDeduplicator};
use crate::sidecar_protocol::{input_event_frame, snapshot_result_frame, SnapshotOutcome};
use crate::transport::{DeviceTransport, TransportError};
use serde_json::Value;

const OUTPUT_METHODS: [&str; 2] = ["v.oai.rgbcfg", "v.oai.thstatus"];

/// Cross-command state for one connected session: the monotonic request-id
/// counter and the per-method duplicate-snapshot baseline. A fresh
/// `Session` per connection matches a fresh device handshake.
#[derive(Default)]
pub struct Session {
    dedup: SnapshotDeduplicator,
    ids: RequestIdGenerator,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Handles one full `output_snapshot` command (`rgbcfg` plus six-slot
    /// `thstatus`). Each method that changed since the last accepted
    /// snapshot is sent exactly once, through the existing
    /// known-firmware-gated `send_state_command` path, with its own
    /// monotonic id. A method whose params are byte-identical to the last
    /// accepted snapshot produces no HID write and reports `duplicate`.
    /// Returns every frame to emit, in order: one `snapshot_result` per
    /// method, plus any device events observed while awaiting each ack.
    pub fn handle_output_snapshot<T: DeviceTransport>(
        &mut self,
        transport: &T,
        parser: &mut Report6Parser,
        gate: &RuntimeGate,
        rgbcfg: Value,
        thstatus: Value,
        ack_attempts: u32,
        read_timeout_ms: i32,
    ) -> Result<Vec<Value>, TransportError> {
        let mut frames = Vec::new();
        for (method, params) in OUTPUT_METHODS.into_iter().zip([rgbcfg, thstatus]) {
            if self.dedup.is_duplicate(method, &params) {
                frames.push(snapshot_result_frame(
                    method,
                    SnapshotOutcome::Duplicate,
                    None,
                ));
                continue;
            }

            let accepted_snapshot = params.clone();
            let id = self.ids.next_id();
            let outcome = send_state_command(
                transport,
                parser,
                gate,
                method,
                params,
                id,
                ack_attempts,
                read_timeout_ms,
            )?;

            let (snapshot_outcome, events, accepted) = match outcome {
                SendOutcome::Blocked => (SnapshotOutcome::Blocked, Vec::new(), false),
                SendOutcome::Sent {
                    outcome, events, ..
                } => (
                    match outcome {
                        AckOutcome::Matched => SnapshotOutcome::Matched,
                        AckOutcome::Indeterminate => SnapshotOutcome::Indeterminate,
                    },
                    events,
                    true,
                ),
            };
            if accepted {
                self.dedup.record(method, &accepted_snapshot);
            }
            frames.push(snapshot_result_frame(method, snapshot_outcome, Some(id)));
            for event in &events {
                let value = serde_json::to_value(event).expect("device events always serialize");
                frames.push(input_event_frame(&value));
            }
        }
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::FirmwareAccess;
    use std::cell::{Cell, RefCell};

    struct FakeTransport {
        write_calls: Cell<usize>,
        reads: RefCell<Vec<Vec<u8>>>,
    }

    impl FakeTransport {
        fn new(reads: Vec<Vec<u8>>) -> Self {
            Self {
                write_calls: Cell::new(0),
                reads: RefCell::new(reads),
            }
        }
    }

    impl DeviceTransport for FakeTransport {
        fn read_timeout(
            &self,
            buffer: &mut [u8],
            _timeout_ms: i32,
        ) -> Result<usize, TransportError> {
            let mut reads = self.reads.borrow_mut();
            if reads.is_empty() {
                return Ok(0);
            }
            let next = reads.remove(0);
            buffer[..next.len()].copy_from_slice(&next);
            Ok(next.len())
        }

        fn write(&self, report: &[u8]) -> Result<usize, TransportError> {
            self.write_calls.set(self.write_calls.get() + 1);
            Ok(report.len())
        }
    }

    #[test]
    fn a_repeated_identical_snapshot_sends_no_second_write() {
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);
        let mut session = Session::new();
        let rgbcfg = serde_json::json!({"ambient": {"e": 1}});
        let thstatus = serde_json::json!([{"id": 0}]);

        let first = session
            .handle_output_snapshot(
                &transport,
                &mut parser,
                &gate,
                rgbcfg.clone(),
                thstatus.clone(),
                3,
                0,
            )
            .unwrap();
        let writes_after_first = transport.write_calls.get();
        assert!(
            writes_after_first > 0,
            "first snapshot must reach the transport"
        );
        assert!(first
            .iter()
            .any(|frame| frame["type"] == "snapshot_result" && frame["method"] == "v.oai.rgbcfg"));

        let second = session
            .handle_output_snapshot(&transport, &mut parser, &gate, rgbcfg, thstatus, 3, 0)
            .unwrap();

        assert_eq!(
            transport.write_calls.get(),
            writes_after_first,
            "an identical snapshot must not write the transport again"
        );
        for frame in &second {
            assert_eq!(frame["type"], "snapshot_result");
            assert_eq!(frame["outcome"], "duplicate");
            assert!(frame["id"].is_null());
        }
    }

    #[test]
    fn blocked_writes_report_blocked_without_touching_the_transport() {
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadOnly);
        let mut session = Session::new();

        let frames = session
            .handle_output_snapshot(
                &transport,
                &mut parser,
                &gate,
                serde_json::json!({"ambient": {"e": 1}}),
                serde_json::json!([{"id": 0}]),
                3,
                0,
            )
            .unwrap();

        assert_eq!(transport.write_calls.get(), 0);
        for frame in &frames {
            assert_eq!(frame["outcome"], "blocked");
        }

        let repeated = session
            .handle_output_snapshot(
                &transport,
                &mut parser,
                &gate,
                serde_json::json!({"ambient": {"e": 1}}),
                serde_json::json!([{"id": 0}]),
                3,
                0,
            )
            .unwrap();
        for frame in &repeated {
            assert_eq!(frame["outcome"], "blocked");
        }
    }

    #[test]
    fn ids_are_monotonic_across_methods_and_commands() {
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);
        let mut session = Session::new();

        let frames = session
            .handle_output_snapshot(
                &transport,
                &mut parser,
                &gate,
                serde_json::json!({"ambient": {"e": 1}}),
                serde_json::json!([{"id": 0}]),
                3,
                0,
            )
            .unwrap();

        let ids: Vec<u64> = frames
            .iter()
            .filter(|frame| frame["type"] == "snapshot_result")
            .map(|frame| frame["id"].as_u64().unwrap())
            .collect();
        assert_eq!(ids, vec![1, 2]);
    }
}
