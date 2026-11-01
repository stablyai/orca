use std::env;
use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::process::Command;

const ERROR_CANCELLED: u32 = 1223;
const SYNCHRONIZE: u32 = 0x0010_0000;
const INFINITE: u32 = 0xFFFF_FFFF;

/// Exit code the desktop reads as "the user declined Windows' approval prompt".
const CANCELLED_EXIT_CODE: i32 = 2;

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

#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn AllowSetForegroundWindow(pid: u32) -> i32;
}

pub fn run_if_requested() {
    let mut args = env::args_os().skip(1);
    match args.next().as_deref().and_then(OsStr::to_str) {
        Some("--orca-restart-as-administrator") => request_elevation(args),
        Some("--orca-relaunch-after-exit") => relaunch_after_exit(args),
        _ => {}
    }
}

/// Runs unelevated, started by the still-foreground desktop, so Windows can show its prompt in front.
fn request_elevation(mut args: impl Iterator<Item = OsString>) -> ! {
    let (Some(owner_window), Some(elevated_parameters), None) =
        (args.next(), args.next(), args.next())
    else {
        crate::fail("Invalid administrator restart arguments");
    };
    let Some(owner_window) = owner_window
        .to_str()
        .and_then(|value| value.parse::<usize>().ok())
    else {
        crate::fail("Invalid administrator restart owner window");
    };
    let Ok(launcher) = env::current_exe() else {
        crate::fail("Unable to locate the administrator launcher");
    };

    let operation = wide(OsStr::new("runas"));
    let file = wide(launcher.as_os_str());
    let parameters = wide(&elevated_parameters);
    let show = if env::var("ORCA_BACKGROUND_LAUNCH").as_deref() == Ok("1") {
        0
    } else {
        1
    };
    // SAFETY: buffers remain terminated and alive; COM is paired on this thread; the owner HWND is only a hint.
    let (launched, error) = unsafe {
        let initialized = CoInitializeEx(std::ptr::null_mut(), 6) >= 0;
        let result = if initialized {
            ShellExecuteW(
                owner_window as *mut c_void,
                operation.as_ptr(),
                file.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                show,
            ) as isize
        } else {
            0
        };
        let error = GetLastError();
        if initialized {
            CoUninitialize();
        }
        (result > 32, error)
    };
    if launched {
        std::process::exit(0);
    }
    if error == ERROR_CANCELLED {
        std::process::exit(CANCELLED_EXIT_CODE);
    }
    crate::fail(&format!(
        "Windows did not start the administrator restart ({error})"
    ));
}

/// Runs elevated; the desktop's single-instance lock only frees once the previous process exits.
fn relaunch_after_exit(mut args: impl Iterator<Item = OsString>) -> ! {
    let (Some(previous_pid), Some(executable), Some(parameters), None) =
        (args.next(), args.next(), args.next(), args.next())
    else {
        crate::fail("Invalid administrator relaunch arguments");
    };
    let Some(previous_pid) = previous_pid
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
    else {
        crate::fail("Invalid administrator relaunch process id");
    };
    // SAFETY: the handle is closed after the wait; a null handle means the process already exited.
    unsafe {
        let previous = OpenProcess(SYNCHRONIZE, 0, previous_pid);
        if !previous.is_null() {
            WaitForSingleObject(previous, INFINITE);
            CloseHandle(previous);
        }
    }
    match Command::new(executable)
        .raw_arg(parameters)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW only suppresses a console.
        .spawn()
    {
        Ok(child) => {
            // SAFETY: plain Win32 call; failure only leaves the window behind the foreground app.
            unsafe { AllowSetForegroundWindow(child.id()) };
            std::process::exit(0);
        }
        Err(error) => crate::fail(&format!("Unable to start Orca as administrator: {error}")),
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
