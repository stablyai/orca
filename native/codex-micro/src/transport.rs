use std::fmt;

/// Codex Micro's exact USB VID/PID (Work Louder, captured 2026-07-28). Never
/// widened to a guessed range — an unmatched device is simply not opened.
pub const VENDOR_ID: u16 = 0x303a;
pub const PRODUCT_ID: u16 = 0x8360;

#[derive(Debug)]
pub enum TransportError {
    Hid(String),
    NotFound,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::Hid(message) => write!(f, "hid transport error: {message}"),
            TransportError::NotFound => write!(f, "device not found at exact vid/pid or path"),
        }
    }
}

impl std::error::Error for TransportError {}

/// Blocking read/write access to a single claimed HID device. Implementations
/// must never guess report IDs or endpoints beyond what a golden fixture or
/// vendor documentation has proven.
pub trait DeviceTransport: Send {
    fn read_timeout(&self, buffer: &mut [u8], timeout_ms: i32) -> Result<usize, TransportError>;
    fn write(&self, report: &[u8]) -> Result<usize, TransportError>;
}

pub struct HidTransport {
    device: hidapi::HidDevice,
}

impl HidTransport {
    /// Opens the device by exact filesystem/OS path, as surfaced by
    /// discovery — never a guessed or synthesized path.
    pub fn open_by_path(
        api: &hidapi::HidApi,
        path: &std::ffi::CStr,
    ) -> Result<Self, TransportError> {
        let device = api
            .open_path(path)
            .map_err(|error| TransportError::Hid(error.to_string()))?;
        Ok(Self { device })
    }

    /// Opens the device by the exact captured VID/PID. Fails rather than
    /// falling back to any other vendor/product pair.
    pub fn open_by_vid_pid(api: &hidapi::HidApi) -> Result<Self, TransportError> {
        let device = api
            .open(VENDOR_ID, PRODUCT_ID)
            .map_err(|error| TransportError::Hid(error.to_string()))?;
        Ok(Self { device })
    }
}

impl DeviceTransport for HidTransport {
    fn read_timeout(&self, buffer: &mut [u8], timeout_ms: i32) -> Result<usize, TransportError> {
        self.device
            .read_timeout(buffer, timeout_ms)
            .map_err(|error| TransportError::Hid(error.to_string()))
    }

    fn write(&self, report: &[u8]) -> Result<usize, TransportError> {
        self.device
            .write(report)
            .map_err(|error| TransportError::Hid(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_the_exact_captured_vid_pid() {
        assert_eq!(VENDOR_ID, 0x303a);
        assert_eq!(PRODUCT_ID, 0x8360);
    }
}
