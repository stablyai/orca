//! Reads one JSON hook payload from a stdin the caller may never close (#23993, #41298).
//!
//! Why a reader thread: a blocking pipe read cannot time out, so the main thread waits on a
//! channel instead and exits the process even while the reader is still blocked.

use std::io::{self, Read};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How long to wait before and between chunks, and for the whole read.
pub struct Limits {
    pub first_byte: Duration,
    pub idle: Duration,
    pub total: Duration,
    pub max_bytes: usize,
}

/// The bytes read when the value completed, stdin ended or a limit passed; None past `max_bytes`.
pub fn read_json_payload(limits: &Limits) -> Option<Vec<u8>> {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buffer = [0u8; 64 * 1024];
        while let Ok(count) = stdin.read(&mut buffer) {
            if count == 0 || sender.send(buffer[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + limits.total;
    let mut payload = Vec::new();
    let mut scanner = JsonScanner::default();
    let mut wait = limits.first_byte;
    loop {
        let timeout = wait.min(deadline.saturating_duration_since(Instant::now()));
        // A timeout or a closed stdin both end the read with what arrived.
        let Ok(chunk) = receiver.recv_timeout(timeout) else {
            return Some(payload);
        };
        if payload.len() + chunk.len() > limits.max_bytes {
            return None;
        }
        payload.extend_from_slice(&chunk);
        if scanner.feed(&chunk) {
            return Some(payload);
        }
        wait = limits.idle;
    }
}

/// Tracks brackets outside strings to find where the first top-level JSON value ends.
#[derive(Default)]
struct JsonScanner {
    started: bool,
    in_string: bool,
    escaped: bool,
    invalid: bool,
    depth: usize,
}

impl JsonScanner {
    /// True once a complete object or array arrived with nothing but whitespace after it.
    fn feed(&mut self, bytes: &[u8]) -> bool {
        let mut complete = false;
        for &byte in bytes {
            if self.invalid {
                return false;
            }
            if complete {
                // Trailing bytes make this not one value; wait for EOF or a limit instead.
                self.invalid = !byte.is_ascii_whitespace();
                continue;
            }
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.in_string = false;
                }
                continue;
            }
            if !self.started && byte.is_ascii_whitespace() {
                continue;
            }
            match byte {
                b'{' | b'[' => self.depth += 1,
                b'}' | b']' if self.depth > 0 => {
                    self.depth -= 1;
                    complete = self.depth == 0;
                }
                b'"' if self.started => self.in_string = true,
                _ if !self.started => self.invalid = true,
                b'}' | b']' => self.invalid = true,
                _ => {}
            }
            self.started = true;
        }
        complete && !self.invalid
    }
}
