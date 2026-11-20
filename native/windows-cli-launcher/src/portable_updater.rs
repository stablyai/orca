use std::collections::BTreeSet;
use std::env;
use std::ffi::{c_void, OsStr, OsString};
use std::fs;
use std::io;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::portable_authenticode::verify_authenticode;

const SYNCHRONIZE: u32 = 0x0010_0000;
const WAIT_OBJECT_0: u32 = 0;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

const BACKUP_DIR_NAME: &str = "portable-backup";
const ERROR_FILE_NAME: &str = "portable-update-error.txt";
const DATA_DIR_NAME: &str = "data";
const PARENT_WAIT_TIMEOUT_MS: u32 = 30_000;
const RENAME_RETRY_TIMEOUT: Duration = Duration::from_secs(15);
const RENAME_RETRY_INTERVAL: Duration = Duration::from_millis(150);

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

pub fn run() {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let result = match args.first().and_then(|value| value.to_str()) {
        Some("verify-signature") => run_verify_signature(&args[1..]),
        Some("apply") => run_apply(&args[1..]),
        _ => Err("Usage: orca-portable-updater <verify-signature|apply> ...".to_string()),
    };

    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run_verify_signature(args: &[OsString]) -> Result<(), String> {
    let mut target_path: Option<PathBuf> = None;
    let mut publisher: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == OsStr::new("--publisher") {
            let value = args
                .get(index + 1)
                .and_then(|v| v.to_str())
                .ok_or_else(|| "Missing value for --publisher".to_string())?;
            publisher = Some(value.to_string());
            index += 2;
        } else if target_path.is_none() {
            target_path = Some(PathBuf::from(&args[index]));
            index += 1;
        } else {
            return Err("Unexpected arguments to verify-signature".to_string());
        }
    }
    let path = target_path.ok_or_else(|| "Missing file path for verify-signature".to_string())?;
    let signer = verify_authenticode(&path, publisher.as_deref())?;
    println!("{signer}");
    Ok(())
}

struct ApplyArgs {
    parent_pid: Option<u32>,
    staged: PathBuf,
    target: PathBuf,
    work: PathBuf,
    relaunch: bool,
}

fn parse_apply_args(args: &[OsString]) -> Result<ApplyArgs, String> {
    let mut parent_pid: Option<u32> = None;
    let mut staged: Option<PathBuf> = None;
    let mut target: Option<PathBuf> = None;
    let mut work: Option<PathBuf> = None;
    let mut relaunch = false;

    let mut index = 0;
    while index < args.len() {
        match args[index].to_str() {
            Some("--parent-pid") => {
                let raw = args
                    .get(index + 1)
                    .and_then(|v| v.to_str())
                    .ok_or_else(|| "Missing value for --parent-pid".to_string())?;
                parent_pid = Some(
                    raw.parse::<u32>()
                        .map_err(|_| format!("Invalid --parent-pid: {raw}"))?,
                );
                index += 2;
            }
            Some("--staged") => {
                staged = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "Missing value for --staged".to_string())?,
                ));
                index += 2;
            }
            Some("--target") => {
                target = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "Missing value for --target".to_string())?,
                ));
                index += 2;
            }
            Some("--work") => {
                work = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "Missing value for --work".to_string())?,
                ));
                index += 2;
            }
            Some("--relaunch") => {
                relaunch = true;
                index += 1;
            }
            _ => return Err("Unexpected argument to apply".to_string()),
        }
    }

    Ok(ApplyArgs {
        parent_pid,
        staged: staged.ok_or_else(|| "Missing --staged".to_string())?,
        target: target.ok_or_else(|| "Missing --target".to_string())?,
        work: work.ok_or_else(|| "Missing --work".to_string())?,
        relaunch,
    })
}

fn run_apply(args: &[OsString]) -> Result<(), String> {
    let config = parse_apply_args(args)?;
    let _ = fs::remove_file(config.work.join(ERROR_FILE_NAME));

    if let Some(pid) = config.parent_pid {
        wait_for_parent_exit(pid)?;
    }

    let apply_result = apply_staged_update(&config.staged, &config.target, &config.work);
    if let Err(error) = &apply_result {
        let _ = fs::write(config.work.join(ERROR_FILE_NAME), error.as_bytes());
    }
    apply_result?;

    if config.relaunch {
        relaunch_orca(&config.target)?;
    }
    Ok(())
}

fn wait_for_parent_exit(pid: u32) -> Result<(), String> {
    // SAFETY: OpenProcess returns null if the parent already exited; WaitForSingleObject + CloseHandle are paired.
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return Ok(());
        }
        let waited = WaitForSingleObject(handle, PARENT_WAIT_TIMEOUT_MS);
        CloseHandle(handle);
        if waited != WAIT_OBJECT_0 {
            return Err(format!(
                "Timed out waiting for Orca process {pid} to exit before applying portable update"
            ));
        }
    }
    Ok(())
}

fn ensure_not_reparse_point(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
            {
                return Err(format!(
                    "Portable update refused: path is a symlink or reparse point: {}",
                    path.display()
                ));
            }
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to inspect path {}: {error}",
            path.display()
        )),
    }
}

fn collect_staged_entries(staged: &Path) -> Result<Vec<OsString>, String> {
    let staged_meta = ensure_not_reparse_point(staged)?
        .ok_or_else(|| format!("Staged update directory does not exist: {}", staged.display()))?;
    if !staged_meta.is_dir() {
        return Err(format!(
            "Staged update path is not a directory: {}",
            staged.display()
        ));
    }

    let exe_meta = ensure_not_reparse_point(&staged.join("Orca.exe"))?;
    if !exe_meta.is_some_and(|meta| meta.is_file()) {
        return Err("Staged portable update is missing Orca.exe".to_string());
    }
    let asar_meta = ensure_not_reparse_point(&staged.join("resources").join("app.asar"))?;
    if !asar_meta.is_some_and(|meta| meta.is_file()) {
        return Err("Staged portable update is missing resources/app.asar".to_string());
    }
    let marker = fs::read_to_string(staged.join("resources").join("package-type"))
        .map_err(|error| format!("Staged portable update is missing package-type marker: {error}"))?;
    if marker.trim() != "portable" {
        return Err("Staged portable update package-type marker is not 'portable'".to_string());
    }

    let mut entries = Vec::new();
    let mut seen_lower = BTreeSet::new();
    let read_dir = fs::read_dir(staged)
        .map_err(|error| format!("Failed to list staged directory: {error}"))?;
    for entry in read_dir {
        let entry = entry.map_err(|error| format!("Failed to read staged entry: {error}"))?;
        let name = entry.file_name();
        let lower = name.to_string_lossy().to_ascii_lowercase();
        if lower == DATA_DIR_NAME {
            continue;
        }
        ensure_not_reparse_point(&entry.path())?;
        if !seen_lower.insert(lower) {
            return Err(format!(
                "Duplicate case-insensitive staged entry: {}",
                name.to_string_lossy()
            ));
        }
        entries.push(name);
    }
    Ok(entries)
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    let deadline = Instant::now() + RENAME_RETRY_TIMEOUT;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let retryable = matches!(
                    error.raw_os_error(),
                    Some(5) | Some(32) | Some(33) // ERROR_ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION
                );
                if !retryable || Instant::now() >= deadline {
                    return Err(format!(
                        "Failed to move {} -> {}: {error}",
                        from.display(),
                        to.display()
                    ));
                }
                thread::sleep(RENAME_RETRY_INTERVAL);
            }
        }
    }
}

fn apply_staged_update(staged: &Path, target: &Path, work: &Path) -> Result<(), String> {
    let backup = work.join(BACKUP_DIR_NAME);
    if backup.exists() {
        return Err(format!(
            "A previous portable update backup already exists at {}; refusing to overwrite recovery state",
            backup.display()
        ));
    }

    let target_meta = ensure_not_reparse_point(target)?
        .ok_or_else(|| format!("Target directory does not exist: {}", target.display()))?;
    if !target_meta.is_dir() {
        return Err(format!("Target path is not a directory: {}", target.display()));
    }

    let entries = collect_staged_entries(staged)?;
    for name in &entries {
        ensure_not_reparse_point(&target.join(name))?;
    }

    fs::create_dir_all(&backup)
        .map_err(|error| format!("Failed to create backup directory: {error}"))?;

    let mut backed_up: Vec<OsString> = Vec::new();
    let mut installed: Vec<OsString> = Vec::new();

    let commit_result = (|| -> Result<(), String> {
        for name in &entries {
            let current = target.join(name);
            if current.exists() {
                rename_with_retry(&current, &backup.join(name))?;
                backed_up.push(name.clone());
            }
        }
        for name in &entries {
            rename_with_retry(&staged.join(name), &target.join(name))?;
            installed.push(name.clone());
        }
        Ok(())
    })();

    if let Err(commit_error) = commit_result {
        let mut rollback_errors = Vec::new();
        for name in installed.iter().rev() {
            if let Err(error) = rename_with_retry(&target.join(name), &staged.join(name)) {
                rollback_errors.push(error);
            }
        }
        for name in backed_up.iter().rev() {
            if let Err(error) = rename_with_retry(&backup.join(name), &target.join(name)) {
                rollback_errors.push(error);
            }
        }
        if rollback_errors.is_empty() {
            let _ = fs::remove_dir_all(&backup);
            return Err(commit_error);
        }
        return Err(format!(
            "{commit_error}; rollback also encountered errors (backup retained at {}): {}",
            backup.display(),
            rollback_errors.join("; ")
        ));
    }

    let _ = fs::remove_dir_all(&backup);
    let _ = fs::remove_dir_all(staged);
    Ok(())
}

fn relaunch_orca(target: &Path) -> Result<(), String> {
    let exe = target.join("Orca.exe");
    Command::new(&exe)
        .current_dir(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|error| format!("Update applied, but failed to relaunch {}: {error}", exe.display()))?;
    Ok(())
}
