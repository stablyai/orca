use serde_json::Value;
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
/// HID Report 6 keeps its own three-byte header; this codec never shares
/// framing logic with it.
pub const MAX_FRAME_BYTES: u32 = 64 * 1024;

#[derive(Debug)]
pub enum SidecarError {
    Io(io::Error),
    FrameTooLarge(u32),
    Malformed(String),
    UnsupportedVersion(u32),
}

impl From<io::Error> for SidecarError {
    fn from(error: io::Error) -> Self {
        SidecarError::Io(error)
    }
}

/// Writes `message` as a four-byte big-endian length prefix followed by its
/// JSON bytes. Rejects oversized frames before ever touching the writer.
pub fn write_frame<W: Write>(writer: &mut W, message: &Value) -> Result<(), SidecarError> {
    let bytes =
        serde_json::to_vec(message).map_err(|error| SidecarError::Malformed(error.to_string()))?;
    let len = u32::try_from(bytes.len()).map_err(|_| SidecarError::FrameTooLarge(u32::MAX))?;
    if len > MAX_FRAME_BYTES {
        return Err(SidecarError::FrameTooLarge(len));
    }
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

/// Reads one length-prefixed JSON frame and validates its declared
/// `version` matches the version this build supports. Rejects an oversized
/// declared length before allocating or reading its body.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Value, SidecarError> {
    let mut len_bytes = [0u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes);
    if len > MAX_FRAME_BYTES {
        return Err(SidecarError::FrameTooLarge(len));
    }

    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body)?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|error| SidecarError::Malformed(error.to_string()))?;

    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| SidecarError::Malformed("missing version field".to_string()))?;
    if version != PROTOCOL_VERSION as u64 {
        return Err(SidecarError::UnsupportedVersion(version as u32));
    }

    Ok(value)
}

pub fn input_event_frame(event: &Value) -> Value {
    serde_json::json!({ "version": PROTOCOL_VERSION, "type": "input_event", "event": event })
}

/// Sent once at session start to negotiate protocol version.
pub fn handshake_frame() -> Value {
    serde_json::json!({
        "version": PROTOCOL_VERSION,
        "type": "handshake",
        "protocolVersion": PROTOCOL_VERSION,
    })
}

/// Redacted connection state matching the shared renderer contract. Firmware
/// version and battery facts are safe; serials, paths, and raw reports are not.
pub fn connection_state_frame(
    firmware: Option<&str>,
    battery: Option<u8>,
    charging: Option<bool>,
) -> Value {
    let mut state = match firmware {
        Some("v0.4.1") => serde_json::json!({
            "kind": "connected",
            "firmware": "v0.4.1",
        }),
        value => serde_json::json!({
            "kind": "read-only",
            "firmware": value,
            "reason": "unknown-firmware",
        }),
    };
    if state["kind"] == "connected" {
        if let Some(value) = battery {
            state["battery"] = Value::from(value);
        }
        if let Some(value) = charging {
            state["charging"] = Value::from(value);
        }
    }
    serde_json::json!({
        "version": PROTOCOL_VERSION,
        "type": "connection_state",
        "state": state,
    })
}

/// A coarse, redacted error summary — `message` must never carry a raw
/// hidapi error string, device path, serial, or report bytes.
pub fn error_frame(message: &str) -> Value {
    serde_json::json!({ "version": PROTOCOL_VERSION, "type": "error", "message": message })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotOutcome {
    Matched,
    Indeterminate,
    Blocked,
    Duplicate,
}

pub fn snapshot_result_frame(method: &str, outcome: SnapshotOutcome, id: Option<u64>) -> Value {
    let outcome = match outcome {
        SnapshotOutcome::Matched => "matched",
        SnapshotOutcome::Indeterminate => "indeterminate",
        SnapshotOutcome::Blocked => "blocked",
        SnapshotOutcome::Duplicate => "duplicate",
    };
    serde_json::json!({
        "version": PROTOCOL_VERSION,
        "type": "snapshot_result",
        "method": method,
        "outcome": outcome,
        "id": id,
    })
}

/// A command decoded from an incoming stdin frame.
#[derive(Debug, Clone, PartialEq)]
pub enum SidecarCommand {
    Release,
    /// A full output snapshot: `rgbcfg` params plus the six-slot `thstatus`
    /// params, sent together so a receiver never has to merge partial state.
    OutputSnapshot {
        rgbcfg: Value,
        thstatus: Value,
    },
}

fn has_exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && object.keys().all(|key| expected.contains(&key.as_str()))
}

fn is_binary(value: &Value) -> bool {
    matches!(value.as_u64(), Some(0 | 1))
}

fn is_unit_interval(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && (0.0..=1.0).contains(&number))
}

fn is_wire_color(value: &Value) -> bool {
    value.as_str().is_some_and(|color| {
        color.len() == 8
            && color.starts_with("0x")
            && color[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn is_wire_light(value: &Value) -> bool {
    has_exact_keys(value, &["e", "b", "s", "m", "c"])
        && is_binary(&value["e"])
        && is_unit_interval(&value["b"])
        && value["s"] == 0
        && value["m"] == 0
        && is_wire_color(&value["c"])
}

fn is_wire_slot(value: &Value, expected_id: usize) -> bool {
    has_exact_keys(value, &["id", "c", "b", "e", "s", "sk", "sa"])
        && value["id"].as_u64() == Some(expected_id as u64)
        && is_wire_color(&value["c"])
        && is_unit_interval(&value["b"])
        && is_binary(&value["e"])
        && value["s"] == 0
        && value["sk"] == 0
        && value["sa"] == 0
}

fn is_valid_output_snapshot(rgbcfg: &Value, thstatus: &Value) -> bool {
    has_exact_keys(rgbcfg, &["ambient", "keys"])
        && is_wire_light(&rgbcfg["ambient"])
        && is_wire_light(&rgbcfg["keys"])
        && thstatus.as_array().is_some_and(|slots| {
            slots.len() == 6
                && slots
                    .iter()
                    .enumerate()
                    .all(|(id, slot)| is_wire_slot(slot, id))
        })
}

/// Parses a decoded frame body into a typed command. Returns `None` for an
/// unrecognized or incomplete command rather than surfacing its raw content
/// — the caller must silently ignore it, not echo it back.
pub fn parse_command(value: &Value) -> Option<SidecarCommand> {
    match value.get("type").and_then(Value::as_str)? {
        "release" => Some(SidecarCommand::Release),
        "output_snapshot" => {
            let rgbcfg = value.get("rgbcfg")?;
            let thstatus = value.get("thstatus")?;
            if !is_valid_output_snapshot(rgbcfg, thstatus) {
                return None;
            }
            Some(SidecarCommand::OutputSnapshot {
                rgbcfg: rgbcfg.clone(),
                thstatus: thstatus.clone(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn full_snapshot() -> Value {
        let light = serde_json::json!({"e": 1, "b": 0.5, "s": 0, "m": 0, "c": "0xffffff"});
        let slots: Vec<Value> = (0..6)
            .map(|id| serde_json::json!({"id": id, "c": "0xffffff", "b": 0.5, "e": 1, "s": 0, "sk": 0, "sa": 0}))
            .collect();
        serde_json::json!({
            "version": 1,
            "type": "output_snapshot",
            "rgbcfg": {"ambient": light, "keys": light},
            "thstatus": slots,
        })
    }

    #[test]
    fn round_trips_a_frame_through_write_and_read() {
        let message = serde_json::json!({"version": 1, "type": "input_event", "event": {"kind": "control", "control": "AG00", "action": 1}});
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &message).unwrap();

        let mut cursor = Cursor::new(buffer);
        let decoded = read_frame(&mut cursor).unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn rejects_a_declared_length_over_the_bound() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&(MAX_FRAME_BYTES + 1).to_be_bytes());
        let mut cursor = Cursor::new(buffer);
        let result = read_frame(&mut cursor);
        assert!(matches!(result, Err(SidecarError::FrameTooLarge(_))));
    }

    #[test]
    fn rejects_an_unsupported_protocol_version() {
        let message = serde_json::json!({"version": 99, "type": "input_event", "event": {}});
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &message).unwrap();

        let mut cursor = Cursor::new(buffer);
        let result = read_frame(&mut cursor);
        assert!(matches!(result, Err(SidecarError::UnsupportedVersion(99))));
    }

    #[test]
    fn input_event_frame_carries_the_shared_contract_shape() {
        let event = serde_json::json!({"kind": "radar", "angle": 0.1, "distance": 0.2});
        let frame = input_event_frame(&event);
        assert_eq!(frame["version"], 1);
        assert_eq!(frame["type"], "input_event");
        assert_eq!(frame["event"], event);
    }

    #[test]
    fn handshake_frame_reports_the_protocol_version() {
        let frame = handshake_frame();
        assert_eq!(frame["version"], 1);
        assert_eq!(frame["type"], "handshake");
        assert_eq!(frame["protocolVersion"], 1);
    }

    #[test]
    fn connection_state_frame_matches_the_shared_known_firmware_contract() {
        let frame = connection_state_frame(Some("v0.4.1"), Some(81), Some(true));
        assert_eq!(frame["type"], "connection_state");
        assert_eq!(frame["state"]["kind"], "connected");
        assert_eq!(frame["state"]["firmware"], "v0.4.1");
        assert_eq!(frame["state"]["battery"], 81);
        assert_eq!(frame["state"]["charging"], true);
        assert_eq!(
            frame.as_object().unwrap().len(),
            3,
            "must carry no fields beyond version/type/state"
        );
    }

    #[test]
    fn connection_state_frame_fails_closed_for_unknown_firmware() {
        let frame = connection_state_frame(Some("v9.9.9"), None, None);
        assert_eq!(frame["state"]["kind"], "read-only");
        assert_eq!(frame["state"]["firmware"], "v9.9.9");
        assert_eq!(frame["state"]["reason"], "unknown-firmware");
    }

    #[test]
    fn error_frame_carries_exactly_the_given_message() {
        let frame = error_frame("hid transport error");
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["message"], "hid transport error");
    }

    #[test]
    fn snapshot_result_frame_encodes_every_outcome() {
        let cases = [
            (SnapshotOutcome::Matched, "matched"),
            (SnapshotOutcome::Indeterminate, "indeterminate"),
            (SnapshotOutcome::Blocked, "blocked"),
            (SnapshotOutcome::Duplicate, "duplicate"),
        ];
        for (outcome, expected) in cases {
            let frame = snapshot_result_frame("v.oai.rgbcfg", outcome, Some(3));
            assert_eq!(frame["type"], "snapshot_result");
            assert_eq!(frame["method"], "v.oai.rgbcfg");
            assert_eq!(frame["outcome"], expected);
            assert_eq!(frame["id"], 3);
        }
    }

    #[test]
    fn snapshot_result_frame_id_is_null_when_absent() {
        let frame = snapshot_result_frame("v.oai.rgbcfg", SnapshotOutcome::Duplicate, None);
        assert!(frame["id"].is_null());
    }

    #[test]
    fn parses_a_release_command() {
        let value = serde_json::json!({"version": 1, "type": "release"});
        assert_eq!(parse_command(&value), Some(SidecarCommand::Release));
    }

    #[test]
    fn parses_a_full_output_snapshot_command() {
        let value = full_snapshot();
        assert!(matches!(
            parse_command(&value),
            Some(SidecarCommand::OutputSnapshot { .. })
        ));
    }

    #[test]
    fn rejects_partial_or_extra_field_output_snapshots() {
        let mut partial = full_snapshot();
        partial["thstatus"] = serde_json::json!([{"id": 0}]);
        assert_eq!(parse_command(&partial), None);

        let mut extra = full_snapshot();
        extra["rgbcfg"]["ambient"]["raw"] = Value::Bool(true);
        assert_eq!(parse_command(&extra), None);
    }

    #[test]
    fn an_output_snapshot_missing_thstatus_does_not_parse() {
        let value = serde_json::json!({
            "version": 1,
            "type": "output_snapshot",
            "rgbcfg": {"ambient": {"e": 1}},
        });
        assert_eq!(parse_command(&value), None);
    }

    #[test]
    fn an_unrecognized_command_type_does_not_parse() {
        let value = serde_json::json!({"version": 1, "type": "reboot"});
        assert_eq!(parse_command(&value), None);
    }
}
