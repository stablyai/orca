use crate::events::{decode_event_json, DeviceEvent};
use serde_json::Value;

const REPORT_ID: u8 = 6;
const FRAME_MARKER: u8 = 2;
const MAX_CHUNK_LEN: usize = 61;
const MAX_PENDING_BYTES: usize = 4096;

const HID_EVENT_SIGNATURE: &[u8] = b"{\"m\":\"v.oai.hid\"";
const RADAR_EVENT_SIGNATURE: &[u8] = b"{\"m\":\"v.oai.rad\"";

/// Events and response fragments decoded from a single `push_report` call.
/// `response_chunks` are raw, unmerged byte spans left over once complete
/// events have been extracted — a chunk that isn't independently valid JSON
/// must be treated as an indeterminate acknowledgement by the caller, never
/// stitched back together across an event boundary.
#[derive(Debug, Default)]
pub struct ParseResult {
    pub events: Vec<DeviceEvent>,
    pub response_chunks: Vec<Vec<u8>>,
}

/// Reassembles HID Report 6 vendor-channel traffic (`[0x06, 0x02, len, ...]`,
/// `len <= 61`) into complete `v.oai.hid` / `v.oai.rad` events, byte-scanning
/// for event signatures so a genuine event is decoded even when the device
/// interleaves it inside an in-flight command acknowledgement.
#[derive(Default)]
pub struct Report6Parser {
    buf: Vec<u8>,
}

impl Report6Parser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_report(&mut self, report: &[u8]) -> ParseResult {
        let mut result = ParseResult::default();

        if report.len() < 3 || report[0] != REPORT_ID || report[1] != FRAME_MARKER {
            return result;
        }
        let len = report[2] as usize;
        if len > MAX_CHUNK_LEN || report.len() < 3 + len {
            return result;
        }
        self.buf.extend_from_slice(&report[3..3 + len]);

        loop {
            let Some(sig_pos) = find_event_signature(&self.buf) else {
                break;
            };
            let Some(end) = balanced_json_end(&self.buf, sig_pos) else {
                break;
            };

            if sig_pos > 0 {
                result.response_chunks.push(self.buf[..sig_pos].to_vec());
            }

            let event_bytes = &self.buf[sig_pos..=end];
            if let Ok(value) = serde_json::from_slice::<Value>(event_bytes) {
                if let Some(event) = decode_event_json(&value) {
                    result.events.push(event);
                }
            }

            self.buf.drain(..=end);
        }

        if !self.buf.is_empty() && find_event_signature(&self.buf).is_none() {
            match serde_json::from_slice::<Value>(&self.buf) {
                Ok(_) => {
                    result.response_chunks.push(self.buf.clone());
                    self.buf.clear();
                }
                Err(err) if !err.is_eof() => {
                    // Not valid JSON and never will be by appending more
                    // bytes (a syntax error, not truncation) — flush it so
                    // the caller can see it and time it out rather than
                    // buffering it forever.
                    result.response_chunks.push(self.buf.clone());
                    self.buf.clear();
                }
                Err(_) => {
                    // Truncated but still a JSON prefix; wait for more bytes.
                }
            }
        }

        if self.buf.len() > MAX_PENDING_BYTES {
            result.response_chunks.push(std::mem::take(&mut self.buf));
        }

        result
    }
}

fn find_event_signature(buf: &[u8]) -> Option<usize> {
    let hid = find_subslice(buf, HID_EVENT_SIGNATURE);
    let radar = find_subslice(buf, RADAR_EVENT_SIGNATURE);
    match (hid, radar) {
        (Some(h), Some(r)) => Some(h.min(r)),
        (Some(h), None) => Some(h),
        (None, Some(r)) => Some(r),
        (None, None) => None,
    }
}

fn find_subslice(buf: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || buf.len() < needle.len() {
        return None;
    }
    buf.windows(needle.len())
        .position(|window| window == needle)
}

/// Finds the end index (inclusive) of the balanced `{...}` object starting
/// at `start`, respecting quoted strings and backslash escapes so braces
/// inside string values don't affect depth. Returns `None` if the object is
/// not yet complete within `buf`.
fn balanced_json_end(buf: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, &byte) in buf[start..].iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + offset);
                }
            }
            _ => {}
        }
    }

    None
}
