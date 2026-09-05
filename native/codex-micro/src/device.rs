use crate::events::DeviceEvent;
use crate::report6::Report6Parser;
use crate::runtime_commands::{
    build_command, classify_ack, is_write_method, AckOutcome, STATUS_METHOD,
};
use crate::transport::{DeviceTransport, TransportError};
use serde_json::Value;

/// Only exactly `v0.4.1` may take reversible `v.oai.rgbcfg`/`v.oai.thstatus`
/// writes. Every other firmware string, and an unknown/absent one, stays
/// read-only — fail closed around unproven hardware.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirmwareAccess {
    ReadWrite,
    ReadOnly,
}

pub fn classify_firmware(value: Option<&str>) -> FirmwareAccess {
    match value {
        Some("v0.4.1") => FirmwareAccess::ReadWrite,
        _ => FirmwareAccess::ReadOnly,
    }
}

pub struct RuntimeGate {
    access: FirmwareAccess,
}

impl RuntimeGate {
    pub fn new(access: FirmwareAccess) -> Self {
        Self { access }
    }

    pub fn allows_write(&self) -> bool {
        matches!(self.access, FirmwareAccess::ReadWrite)
    }
}

const REPORT_ID: u8 = 6;
const FRAME_MARKER: u8 = 2;
const MAX_CHUNK_LEN: usize = 61;
const REPORT_SIZE: usize = 64;

/// Splits a JSON command into one or more 64-byte Report 6 output frames,
/// each carrying up to 61 payload bytes behind the `[report_id, marker,
/// len]` header — the same wire layout `Report6Parser` decodes.
pub fn encode_report6_frames(json_bytes: &[u8]) -> Vec<[u8; REPORT_SIZE]> {
    json_bytes
        .chunks(MAX_CHUNK_LEN)
        .map(|chunk| {
            let mut frame = [0u8; REPORT_SIZE];
            frame[0] = REPORT_ID;
            frame[1] = FRAME_MARKER;
            frame[2] = chunk.len() as u8;
            frame[3..3 + chunk.len()].copy_from_slice(chunk);
            frame
        })
        .collect()
}

fn write_command<T: DeviceTransport>(transport: &T, command: &Value) -> Result<(), TransportError> {
    let bytes = serde_json::to_vec(command).expect("command is always valid JSON");
    for frame in encode_report6_frames(&bytes) {
        transport.write(&frame)?;
    }
    Ok(())
}

fn find_response_value(chunks: &[Vec<u8>], id: u64, method: &str) -> Option<Value> {
    chunks.iter().find_map(|chunk| {
        let value: Value = serde_json::from_slice(chunk).ok()?;
        let matches = value.get("id").and_then(Value::as_u64) == Some(id)
            && value.get("method").and_then(Value::as_str) == Some(method);
        matches.then_some(value)
    })
}

/// Reads up to `attempts` reports, feeding them through `parser`, looking
/// for a response chunk whose `id` matches. Collects every decoded device
/// event seen along the way so a genuine input is never dropped while
/// waiting on an acknowledgement. Exhausting `attempts` without a match is
/// an indeterminate outcome, not a retry trigger — the caller writes the
/// command exactly once.
fn await_response<T: DeviceTransport>(
    transport: &T,
    parser: &mut Report6Parser,
    id: u64,
    method: &str,
    attempts: u32,
    read_timeout_ms: i32,
) -> Result<(Option<Value>, Vec<DeviceEvent>), TransportError> {
    let mut events = Vec::new();
    for _ in 0..attempts {
        let mut buffer = [0u8; REPORT_SIZE];
        let n = transport.read_timeout(&mut buffer, read_timeout_ms)?;
        if n == 0 {
            continue;
        }
        let result = parser.push_report(&buffer[..n]);
        events.extend(result.events);
        if let Some(value) = find_response_value(&result.response_chunks, id, method) {
            return Ok((Some(value), events));
        }
    }
    Ok((None, events))
}

#[derive(Debug, Clone, PartialEq)]
pub enum SendOutcome {
    Blocked,
    Sent {
        id: u64,
        outcome: AckOutcome,
        events: Vec<DeviceEvent>,
    },
}

/// Reads up to `attempts` reports looking for a chunk that matches `id`,
/// `method`, and `result.ok == 1` all at once — anything else (wrong id,
/// wrong method, missing/zero `ok`, malformed JSON, or exhausting
/// `attempts`) is indeterminate. Collects every decoded device event seen
/// along the way so a genuine input is never dropped while waiting.
fn await_ack<T: DeviceTransport>(
    transport: &T,
    parser: &mut Report6Parser,
    id: u64,
    method: &str,
    attempts: u32,
    read_timeout_ms: i32,
) -> Result<(AckOutcome, Vec<DeviceEvent>), TransportError> {
    let mut events = Vec::new();
    for _ in 0..attempts {
        let mut buffer = [0u8; REPORT_SIZE];
        let n = transport.read_timeout(&mut buffer, read_timeout_ms)?;
        if n == 0 {
            continue;
        }
        let result = parser.push_report(&buffer[..n]);
        events.extend(result.events);
        for chunk in &result.response_chunks {
            if classify_ack(id, method, chunk) == AckOutcome::Matched {
                return Ok((AckOutcome::Matched, events));
            }
        }
    }
    Ok((AckOutcome::Indeterminate, events))
}

/// Sends one `v.oai.rgbcfg`/`v.oai.thstatus` write when the firmware gate
/// allows it and `method` is one of the captured write methods — every
/// other method is blocked even on known firmware. Writes the transport
/// exactly once — an indeterminate ack never causes a second write from
/// within this function or its caller.
pub fn send_state_command<T: DeviceTransport>(
    transport: &T,
    parser: &mut Report6Parser,
    gate: &RuntimeGate,
    method: &str,
    params: Value,
    id: u64,
    ack_attempts: u32,
    read_timeout_ms: i32,
) -> Result<SendOutcome, TransportError> {
    if !gate.allows_write() || !is_write_method(method) {
        return Ok(SendOutcome::Blocked);
    }

    let command = build_command(method, params, id);
    write_command(transport, &command)?;

    let (outcome, events) =
        await_ack(transport, parser, id, method, ack_attempts, read_timeout_ms)?;
    Ok(SendOutcome::Sent {
        id,
        outcome,
        events,
    })
}

/// Queries `device.status` — always allowed, even in read-only mode, since
/// it is how read-only mode gets established in the first place. An
/// indeterminate response fails closed to `ReadOnly`.
pub fn query_status<T: DeviceTransport>(
    transport: &T,
    parser: &mut Report6Parser,
    id: u64,
    attempts: u32,
    read_timeout_ms: i32,
) -> Result<(FirmwareAccess, Option<Value>, Vec<DeviceEvent>), TransportError> {
    let command = build_command(STATUS_METHOD, Value::Null, id);
    write_command(transport, &command)?;

    let (value, events) = await_response(
        transport,
        parser,
        id,
        STATUS_METHOD,
        attempts,
        read_timeout_ms,
    )?;
    let firmware = value
        .as_ref()
        .and_then(|v| v.get("result"))
        .and_then(|r| r.get("version"))
        .and_then(Value::as_str);
    Ok((classify_firmware(firmware), value, events))
}

#[cfg(test)]
mod tests {
    use super::*;
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

        fn write(&self, _report: &[u8]) -> Result<usize, TransportError> {
            self.write_calls.set(self.write_calls.get() + 1);
            Ok(_report.len())
        }
    }

    fn pack_report(payload: &[u8]) -> Vec<u8> {
        assert!(
            payload.len() <= MAX_CHUNK_LEN,
            "payload exceeds a single report's chunk capacity"
        );
        let mut report = vec![REPORT_ID, FRAME_MARKER, payload.len() as u8];
        report.extend_from_slice(payload);
        report.resize(REPORT_SIZE, 0);
        report
    }

    fn pack_reports(payload: &[u8]) -> Vec<Vec<u8>> {
        encode_report6_frames(payload)
            .into_iter()
            .map(|frame| frame.to_vec())
            .collect()
    }

    #[test]
    fn v0_4_1_is_read_write_and_everything_else_is_read_only() {
        assert_eq!(classify_firmware(Some("v0.4.1")), FirmwareAccess::ReadWrite);
        assert_eq!(classify_firmware(Some("v0.9.9")), FirmwareAccess::ReadOnly);
        assert_eq!(classify_firmware(None), FirmwareAccess::ReadOnly);
    }

    #[test]
    fn read_only_gate_blocks_state_commands_without_touching_the_transport() {
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadOnly);

        let outcome = send_state_command(
            &transport,
            &mut parser,
            &gate,
            "v.oai.rgbcfg",
            Value::Null,
            1,
            3,
            0,
        )
        .unwrap();

        assert_eq!(outcome, SendOutcome::Blocked);
        assert_eq!(transport.write_calls.get(), 0);
    }

    #[test]
    fn an_indeterminate_ack_never_triggers_a_second_write() {
        // No reads ever satisfy the pending id, forcing the ack budget to exhaust.
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);

        let outcome = send_state_command(
            &transport,
            &mut parser,
            &gate,
            "v.oai.rgbcfg",
            Value::Null,
            7,
            5,
            0,
        )
        .unwrap();

        match outcome {
            SendOutcome::Sent { id, outcome, .. } => {
                assert_eq!(id, 7);
                assert_eq!(outcome, AckOutcome::Indeterminate);
            }
            other => panic!("expected Sent, got {other:?}"),
        }
        assert_eq!(
            transport.write_calls.get(),
            1,
            "must write exactly once, never resend"
        );
    }

    #[test]
    fn unsupported_methods_are_blocked_even_on_known_firmware() {
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);

        let outcome = send_state_command(
            &transport,
            &mut parser,
            &gate,
            "v.oai.hid",
            Value::Null,
            1,
            3,
            0,
        )
        .unwrap();

        assert_eq!(outcome, SendOutcome::Blocked);
        assert_eq!(transport.write_calls.get(), 0);
    }

    #[test]
    fn an_ack_with_the_wrong_method_is_indeterminate_and_never_resent() {
        // Correct id and result.ok, but the ack claims a different method.
        let ack = br#"{"result":{"ok":1},"id":9,"method":"v.oai.thstatus"}"#;
        let transport = FakeTransport::new(vec![pack_report(ack)]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);

        let outcome = send_state_command(
            &transport,
            &mut parser,
            &gate,
            "v.oai.rgbcfg",
            Value::Null,
            9,
            3,
            0,
        )
        .unwrap();

        match outcome {
            SendOutcome::Sent { outcome, .. } => assert_eq!(outcome, AckOutcome::Indeterminate),
            other => panic!("expected Sent, got {other:?}"),
        }
        assert_eq!(
            transport.write_calls.get(),
            1,
            "must write exactly once, never resend"
        );
    }

    #[test]
    fn a_matching_ok_ack_is_reported_as_matched() {
        let ack = br#"{"result":{"ok":1},"id":9,"method":"v.oai.rgbcfg"}"#;
        let transport = FakeTransport::new(vec![pack_report(ack)]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);

        let outcome = send_state_command(
            &transport,
            &mut parser,
            &gate,
            "v.oai.rgbcfg",
            Value::Null,
            9,
            3,
            0,
        )
        .unwrap();

        match outcome {
            SendOutcome::Sent { outcome, .. } => assert_eq!(outcome, AckOutcome::Matched),
            other => panic!("expected Sent, got {other:?}"),
        }
        assert_eq!(transport.write_calls.get(), 1);
    }

    #[test]
    fn query_status_classifies_known_firmware_as_read_write() {
        let status =
            br#"{"result":{"version":"v0.4.1","profile_index":0,"layer_index":1,"battery":81,"is_charging":true},"id":3,"method":"device.status"}"#;
        let transport = FakeTransport::new(pack_reports(status));
        let mut parser = Report6Parser::new();

        let (access, value, _events) = query_status(&transport, &mut parser, 3, 3, 0).unwrap();

        assert_eq!(access, FirmwareAccess::ReadWrite);
        assert_eq!(value.unwrap()["result"]["version"], "v0.4.1");
    }

    #[test]
    fn query_status_fails_closed_to_read_only_when_indeterminate() {
        let transport = FakeTransport::new(vec![]);
        let mut parser = Report6Parser::new();

        let (access, value, _events) = query_status(&transport, &mut parser, 3, 3, 0).unwrap();

        assert_eq!(access, FirmwareAccess::ReadOnly);
        assert!(value.is_none());
    }

    #[test]
    fn query_status_rejects_a_response_for_the_wrong_method() {
        let status = br#"{"result":{"firmware":"v0.4.1"},"id":3,"method":"v.oai.rgbcfg"}"#;
        let transport = FakeTransport::new(pack_reports(status));
        let mut parser = Report6Parser::new();

        let (access, value, _events) = query_status(&transport, &mut parser, 3, 3, 0).unwrap();

        assert_eq!(access, FirmwareAccess::ReadOnly);
        assert!(value.is_none());
    }

    #[test]
    fn events_seen_while_waiting_for_an_ack_are_never_dropped() {
        let event_payload = br#"{"m":"v.oai.hid","p":{"k":"AG00","act":1}}"#;
        let transport = FakeTransport::new(vec![pack_report(event_payload)]);
        let mut parser = Report6Parser::new();
        let gate = RuntimeGate::new(FirmwareAccess::ReadWrite);

        let outcome = send_state_command(
            &transport,
            &mut parser,
            &gate,
            "v.oai.rgbcfg",
            Value::Null,
            1,
            3,
            0,
        )
        .unwrap();

        match outcome {
            SendOutcome::Sent {
                outcome, events, ..
            } => {
                assert_eq!(outcome, AckOutcome::Indeterminate);
                assert_eq!(
                    events.len(),
                    1,
                    "the interleaved AG00 press must still surface"
                );
            }
            other => panic!("expected Sent, got {other:?}"),
        }
    }
}
