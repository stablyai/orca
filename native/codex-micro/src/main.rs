use codex_micro::device::{query_status, FirmwareAccess, RuntimeGate};
use codex_micro::report6::Report6Parser;
use codex_micro::sidecar_protocol::{
    connection_state_frame, error_frame, handshake_frame, input_event_frame, parse_command,
    read_frame, write_frame, SidecarCommand,
};
use codex_micro::sidecar_session::Session;
use codex_micro::simulator_transport::SimulatorTransport;
use codex_micro::transport::{DeviceTransport, HidTransport, TransportError};
use serde_json::Value;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::mpsc;
use std::thread;

const STATUS_REQUEST_ID: u64 = 1;
const ACK_ATTEMPTS: u32 = 20;
const ACK_READ_TIMEOUT_MS: i32 = 50;
const HID_POLL_TIMEOUT_MS: i32 = 50;

/// hidapi error text may embed a device path or serial; never forward it to
/// protocol frames or stderr, only this fixed, coarse category.
const REDACTED_TRANSPORT_ERROR: &str = "hid transport error";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let simulate_dir = args
        .iter()
        .position(|arg| arg == "--simulate")
        .and_then(|index| args.get(index + 1));
    let simulate_unknown_firmware = args.iter().any(|arg| arg == "--simulate-unknown-firmware");

    let result = match simulate_dir {
        Some(dir) => run_simulator(Path::new(dir), simulate_unknown_firmware),
        None => run_hardware(),
    };

    if let Err(message) = result {
        eprintln!("codex-micro: {message}");
        std::process::exit(1);
    }
}

/// Runs the full bidirectional session (handshake, connection state,
/// fixture-replayed input events, then live `output_snapshot`/`release`
/// commands) against a loopback `SimulatorTransport` — no hardware, no HID
/// transport. Firmware is simulated as known/read-write so the real
/// known-firmware-gated send path can be exercised end to end.
fn run_simulator(fixture_dir: &Path, unknown_firmware: bool) -> Result<(), String> {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let access = if unknown_firmware {
        FirmwareAccess::ReadOnly
    } else {
        FirmwareAccess::ReadWrite
    };
    let gate = RuntimeGate::new(access);

    write_frame(&mut out, &handshake_frame()).map_err(|error| format!("{error:?}"))?;
    write_frame(
        &mut out,
        &connection_state_frame(
            Some(if unknown_firmware { "v9.9.9" } else { "v0.4.1" }),
            Some(81),
            Some(true),
        ),
    )
    .map_err(|error| format!("{error:?}"))?;

    for file_name in ["input-events.json", "radar-events.json"] {
        let path = fixture_dir.join(file_name);
        let contents =
            fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let fixture: Value = serde_json::from_str(&contents)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let events = fixture["events"]
            .as_array()
            .ok_or_else(|| format!("{}: missing events array", path.display()))?;

        for event in events {
            let frame = input_event_frame(event);
            write_frame(&mut out, &frame).map_err(|error| format!("{error:?}"))?;
        }
    }

    let transport = SimulatorTransport::new();
    let mut parser = Report6Parser::new();
    let mut session = Session::new();
    let stdin = io::stdin();
    let mut stdin_lock = stdin.lock();

    loop {
        let command = match read_frame(&mut stdin_lock) {
            Ok(value) => parse_command(&value),
            Err(_) => break,
        };
        match command {
            Some(SidecarCommand::Release) => break,
            Some(SidecarCommand::OutputSnapshot { rgbcfg, thstatus }) => {
                let frames = session
                    .handle_output_snapshot(
                        &transport,
                        &mut parser,
                        &gate,
                        rgbcfg,
                        thstatus,
                        ACK_ATTEMPTS,
                        0,
                    )
                    .map_err(|error| write_error_frame(&mut out, error))?;
                for frame in frames {
                    write_frame(&mut out, &frame).map_err(|error| format!("{error:?}"))?;
                }
            }
            None => {}
        }
    }

    Ok(())
}

/// Opens the device at the exact captured VID/PID, gates writes behind a
/// `device.status` query, and runs the bidirectional session: HID reads
/// keep flowing every poll interval while a dedicated stdin-reader thread
/// (talking only to stdin, never the transport) feeds decoded commands
/// through a bounded channel. All HID access stays on this thread. A
/// `release` command, or the peer closing stdin, exits cleanly and drops
/// the transport, releasing the device.
fn run_hardware() -> Result<(), String> {
    let api = hidapi::HidApi::new().map_err(|_| REDACTED_TRANSPORT_ERROR.to_string())?;
    let transport =
        HidTransport::open_by_vid_pid(&api).map_err(|_| REDACTED_TRANSPORT_ERROR.to_string())?;

    let mut parser = Report6Parser::new();
    let (access, status, initial_events) = query_status(
        &transport,
        &mut parser,
        STATUS_REQUEST_ID,
        ACK_ATTEMPTS,
        ACK_READ_TIMEOUT_MS,
    )
    .map_err(|_| REDACTED_TRANSPORT_ERROR.to_string())?;
    let gate = RuntimeGate::new(access);
    let mut session = Session::new();

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let status_result = status.as_ref().and_then(|value| value.get("result"));
    let firmware = status_result
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str);
    let battery = status_result
        .and_then(|value| value.get("battery"))
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok());
    let charging = status_result
        .and_then(|value| value.get("is_charging"))
        .and_then(Value::as_bool);
    write_frame(&mut out, &handshake_frame()).map_err(|error| format!("{error:?}"))?;
    write_frame(
        &mut out,
        &connection_state_frame(firmware, battery, charging),
    )
    .map_err(|error| format!("{error:?}"))?;
    for event in &initial_events {
        let value = serde_json::to_value(event).expect("device events always serialize");
        write_frame(&mut out, &input_event_frame(&value)).map_err(|error| format!("{error:?}"))?;
        out.flush().map_err(|error| error.to_string())?;
    }

    let (command_tx, command_rx) = mpsc::sync_channel::<Value>(8);
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin_lock = stdin.lock();
        loop {
            match read_frame(&mut stdin_lock) {
                Ok(value) => {
                    if command_tx.send(value).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    loop {
        match command_rx.try_recv() {
            Ok(value) => match parse_command(&value) {
                Some(SidecarCommand::Release) => return Ok(()),
                Some(SidecarCommand::OutputSnapshot { rgbcfg, thstatus }) => {
                    let frames = session
                        .handle_output_snapshot(
                            &transport,
                            &mut parser,
                            &gate,
                            rgbcfg,
                            thstatus,
                            ACK_ATTEMPTS,
                            ACK_READ_TIMEOUT_MS,
                        )
                        .map_err(|error| write_error_frame(&mut out, error))?;
                    for frame in frames {
                        write_frame(&mut out, &frame).map_err(|error| format!("{error:?}"))?;
                        out.flush().map_err(|error| error.to_string())?;
                    }
                }
                None => {}
            },
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }

        let events = match poll_device_events(&transport, &mut parser, HID_POLL_TIMEOUT_MS) {
            Ok(events) => events,
            Err(error) => return Err(write_error_frame(&mut out, error)),
        };
        for event in &events {
            let value = serde_json::to_value(event).expect("device events always serialize");
            write_frame(&mut out, &input_event_frame(&value))
                .map_err(|error| format!("{error:?}"))?;
            out.flush().map_err(|error| error.to_string())?;
        }
    }
}

fn poll_device_events<T: DeviceTransport>(
    transport: &T,
    parser: &mut Report6Parser,
    timeout_ms: i32,
) -> Result<Vec<codex_micro::events::DeviceEvent>, TransportError> {
    let mut buffer = [0u8; 64];
    let n = transport.read_timeout(&mut buffer, timeout_ms)?;
    Ok(if n == 0 {
        Vec::new()
    } else {
        parser.push_report(&buffer[..n]).events
    })
}

/// Writes a redacted `error` protocol frame and returns the same coarse
/// message so the raw `TransportError` never reaches stdout or stderr.
fn write_error_frame<W: Write>(out: &mut W, _error: TransportError) -> String {
    let _ = write_frame(out, &error_frame(REDACTED_TRANSPORT_ERROR));
    let _ = out.flush();
    REDACTED_TRANSPORT_ERROR.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct OneEventTransport {
        reads: Cell<usize>,
    }

    impl DeviceTransport for OneEventTransport {
        fn read_timeout(
            &self,
            buffer: &mut [u8],
            _timeout_ms: i32,
        ) -> Result<usize, TransportError> {
            self.reads.set(self.reads.get() + 1);
            let payload = br#"{"m":"v.oai.hid","p":{"k":"AG00","act":1}}"#;
            buffer[0] = 6;
            buffer[1] = 2;
            buffer[2] = payload.len() as u8;
            buffer[3..3 + payload.len()].copy_from_slice(payload);
            Ok(3 + payload.len())
        }

        fn write(&self, _report: &[u8]) -> Result<usize, TransportError> {
            Ok(0)
        }
    }

    #[test]
    fn one_poll_performs_one_transport_read_and_returns_the_event() {
        let transport = OneEventTransport {
            reads: Cell::new(0),
        };
        let mut parser = Report6Parser::new();

        let events = poll_device_events(&transport, &mut parser, 0).unwrap();

        assert_eq!(transport.reads.get(), 1);
        assert_eq!(events.len(), 1);
    }
}
