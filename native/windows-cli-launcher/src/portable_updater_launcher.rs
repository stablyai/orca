#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod portable_authenticode;
#[cfg(windows)]
mod portable_updater;

fn main() {
    #[cfg(windows)]
    portable_updater::run();
}
