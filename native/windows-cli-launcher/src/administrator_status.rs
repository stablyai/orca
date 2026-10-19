use std::ffi::c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
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

pub fn run_if_requested() {
    if std::env::args_os().nth(1).as_deref()
        != Some(std::ffi::OsStr::new("--orca-administrator-status"))
    {
        return;
    }
    let mut token = std::ptr::null_mut();
    let mut elevated = 0u32;
    let mut returned = 0;
    // SAFETY: TOKEN_QUERY reads this asInvoker child's token, inherited from the calling desktop.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), 8, &mut token) == 0 {
            crate::fail("Unable to query Windows administrator status");
        }
        let ok = GetTokenInformation(
            token,
            20, // TokenElevation
            &mut elevated as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
            &mut returned,
        );
        CloseHandle(token);
        if ok == 0 || returned != std::mem::size_of::<u32>() as u32 {
            crate::fail("Unable to query Windows administrator status");
        }
    }
    println!("{}", elevated != 0);
    std::process::exit(0);
}
