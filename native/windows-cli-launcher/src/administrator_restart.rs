use std::env;
use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::process::Command;

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        window: *mut c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> *mut c_void;
}

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, mode: u32) -> i32;
    fn CoUninitialize();
}

pub fn run_if_requested() {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new("--orca-restart-as-administrator")) {
        return;
    }
    let (Some(executable), Some(elevated_parameters), Some(ordinary_parameters)) =
        (args.next(), args.next(), args.next())
    else {
        crate::fail("Missing administrator restart arguments");
    };
    if args.next().is_some() {
        crate::fail("Unexpected administrator restart arguments");
    }

    let operation = wide(OsStr::new("runas"));
    let file = wide(&executable);
    let parameters = wide(&elevated_parameters);
    let show = if env::var("ORCA_BACKGROUND_LAUNCH").as_deref() == Ok("1") {
        0
    } else {
        1
    };
    // SAFETY: buffers remain terminated and alive; COM is paired on this thread.
    let launched = unsafe {
        let initialized = CoInitializeEx(std::ptr::null_mut(), 6) >= 0;
        let result = if initialized {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                show,
            ) as isize
        } else {
            0
        };
        if initialized {
            CoUninitialize();
        }
        result > 32
    };
    if launched {
        std::process::exit(0);
    }

    // Cancellation reopens the ordinary desktop without ending its retained terminals.
    match Command::new(executable)
        .raw_arg(ordinary_parameters)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW only suppresses a console.
        .status()
    {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => crate::fail(&format!("Unable to reopen Orca: {error}")),
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
