use crate::device::encode_report6_frames;
use crate::report6::Report6Parser;
use crate::transport::{DeviceTransport, TransportError};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::VecDeque;

/// A loopback device double for `--simulate`: decodes host writes through
/// the same Report 6 framing a real device uses and immediately queues an
/// `ok` ack for every command, so the real known-firmware-gated send path
/// (`device::send_state_command`) can run end to end without hardware.
#[derive(Default)]
pub struct SimulatorTransport {
    host_writes: RefCell<Report6Parser>,
    pending_reads: RefCell<VecDeque<Vec<u8>>>,
}

impl SimulatorTransport {
    pub fn new() -> Self {
        Self::default()
    }
}

impl DeviceTransport for SimulatorTransport {
    fn write(&self, report: &[u8]) -> Result<usize, TransportError> {
        let result = self.host_writes.borrow_mut().push_report(report);
        let mut pending = self.pending_reads.borrow_mut();
        for chunk in &result.response_chunks {
            let Ok(command) = serde_json::from_slice::<Value>(chunk) else {
                continue;
            };
            let (Some(id), Some(method)) = (
                command.get("id").and_then(Value::as_u64),
                command.get("method").and_then(Value::as_str),
            ) else {
                continue;
            };
            let ack = serde_json::json!({"result": {"ok": 1}, "id": id, "method": method});
            let bytes = serde_json::to_vec(&ack).expect("ack is always valid JSON");
            for frame in encode_report6_frames(&bytes) {
                pending.push_back(frame.to_vec());
            }
        }
        Ok(report.len())
    }

    fn read_timeout(&self, buffer: &mut [u8], _timeout_ms: i32) -> Result<usize, TransportError> {
        match self.pending_reads.borrow_mut().pop_front() {
            Some(frame) => {
                buffer[..frame.len()].copy_from_slice(&frame);
                Ok(frame.len())
            }
            None => Ok(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_command_is_immediately_acked_on_the_next_read() {
        let transport = SimulatorTransport::new();
        let command = serde_json::json!({"method": "v.oai.rgbcfg", "params": null, "id": 5});
        let bytes = serde_json::to_vec(&command).unwrap();
        for frame in encode_report6_frames(&bytes) {
            transport.write(&frame).unwrap();
        }

        let mut parser = Report6Parser::new();
        let mut ack_chunk = None;
        for _ in 0..4 {
            let mut buffer = [0u8; 64];
            let n = transport.read_timeout(&mut buffer, 0).unwrap();
            if n == 0 {
                break;
            }
            let result = parser.push_report(&buffer[..n]);
            ack_chunk = result.response_chunks.into_iter().next().or(ack_chunk);
        }

        let ack: Value =
            serde_json::from_slice(&ack_chunk.expect("expected a queued ack")).unwrap();
        assert_eq!(ack["id"], 5);
        assert_eq!(ack["method"], "v.oai.rgbcfg");
        assert_eq!(ack["result"]["ok"], 1);
    }
}
