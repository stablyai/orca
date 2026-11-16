#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod administrator_restart;

fn main() {
    #[cfg(windows)]
    administrator_restart::run_if_requested();
}

#[cfg(windows)]
fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}
