use std::fmt;

/// Codex Micro's exact USB VID/PID (Work Louder, captured 2026-07-28). Never
/// widened to a guessed range — an unmatched device is simply not opened.
pub const VENDOR_ID: u16 = 0x303a;
pub const PRODUCT_ID: u16 = 0x8360;
pub const PROTOCOL_USAGE_PAGE: u16 = 0xff00;
pub const PROTOCOL_USAGE: u16 = 0x0001;
pub const MANUFACTURER: &str = "Work Louder";
pub const PRODUCT_NAME: &str = "Codex Micro";

fn is_protocol_collection(
    vendor_id: u16,
    product_id: u16,
    usage_page: u16,
    usage: u16,
    manufacturer: Option<&str>,
    product_name: Option<&str>,
) -> bool {
    vendor_id == VENDOR_ID
        && product_id == PRODUCT_ID
        && usage_page == PROTOCOL_USAGE_PAGE
        && usage == PROTOCOL_USAGE
        && manufacturer == Some(MANUFACTURER)
        && product_name == Some(PRODUCT_NAME)
}

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

    /// Opens only the vendor protocol collection; the same VID/PID also
    /// exposes keyboard, mouse, gamepad, and consumer-control collections.
    pub fn open_by_vid_pid(api: &hidapi::HidApi) -> Result<Self, TransportError> {
        let info = api
            .device_list()
            .find(|device| {
                is_protocol_collection(
                    device.vendor_id(),
                    device.product_id(),
                    device.usage_page(),
                    device.usage(),
                    device.manufacturer_string(),
                    device.product_string(),
                )
            })
            .ok_or(TransportError::NotFound)?;
        let device = info
            .open_device(api)
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

    #[test]
    fn selects_only_the_vendor_protocol_collection() {
        assert!(is_protocol_collection(
            0x303a,
            0x8360,
            0xff00,
            0x0001,
            Some("Work Louder"),
            Some("Codex Micro")
        ));
        assert!(!is_protocol_collection(
            0x303a,
            0x8360,
            0x0001,
            0x0006,
            Some("Work Louder"),
            Some("Codex Micro")
        ));
        assert!(!is_protocol_collection(
            0x303a,
            0x8360,
            0xff00,
            0x0001,
            Some("Other"),
            Some("Codex Micro")
        ));
    }
}
