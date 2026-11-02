use std::ffi::c_void;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TOKEN_QUERY: u32 = 8;
const TOKEN_ELEVATION: u32 = 20;

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: u32,
        buffer: *mut c_void,
        size: u32,
        returned: *mut u32,
    ) -> i32;
}

/// `--orca-administrator-status [pid]`: without a pid, reports this asInvoker child, i.e. its caller.
pub fn run_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--orca-administrator-status")) {
        return;
    }
    let target = match (args.next(), args.next()) {
        (None, None) => None,
        (Some(pid), None) => match pid.to_str().and_then(|value| value.parse::<u32>().ok()) {
            Some(pid) => Some(pid),
            None => crate::fail("Invalid process id"),
        },
        _ => crate::fail("Unexpected administrator status arguments"),
    };
    match read_elevation(target) {
        Some(elevated) => {
            println!("{elevated}");
            std::process::exit(0);
        }
        None => crate::fail("Unable to query Windows administrator status"),
    }
}

fn read_elevation(pid: Option<u32>) -> Option<bool> {
    // SAFETY: every opened handle is closed; TOKEN_QUERY only reads the token.
    unsafe {
        let process = match pid {
            None => GetCurrentProcess(),
            Some(pid) => {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return None;
                }
                handle
            }
        };
        let mut token = std::ptr::null_mut();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0;
        if pid.is_some() {
            CloseHandle(process);
        }
        if !opened {
            return None;
        }
        let mut elevated = 0u32;
        let mut returned = 0;
        let ok = GetTokenInformation(
            token,
            TOKEN_ELEVATION,
            &mut elevated as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
            &mut returned,
        );
        CloseHandle(token);
        (ok != 0 && returned == std::mem::size_of::<u32>() as u32).then_some(elevated != 0)
    }
}
