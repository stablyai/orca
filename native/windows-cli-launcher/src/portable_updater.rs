use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
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
const TRANSACTION_FILE_NAME: &str = "portable-transaction.txt";
const LOCK_FILE_NAME: &str = "portable-update.lock";
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
        Some("recover") => run_recover(&args[1..]),
        _ => Err("Usage: orca-portable-updater <verify-signature|apply|recover> ...".to_string()),
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
    manifest: PathBuf,
    relaunch: bool,
    user_data_dir: Option<OsString>,
}

fn parse_apply_args(args: &[OsString]) -> Result<ApplyArgs, String> {
    let mut parent_pid: Option<u32> = None;
    let mut staged: Option<PathBuf> = None;
    let mut target: Option<PathBuf> = None;
    let mut work: Option<PathBuf> = None;
    let mut manifest: Option<PathBuf> = None;
    let mut relaunch = false;
    let mut user_data_dir: Option<OsString> = None;

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
            Some("--manifest") => {
                manifest = Some(PathBuf::from(
                    args.get(index + 1)
                        .ok_or_else(|| "Missing value for --manifest".to_string())?,
                ));
                index += 2;
            }
            Some("--user-data-dir") => {
                user_data_dir = Some(
                    args.get(index + 1)
                        .ok_or_else(|| "Missing value for --user-data-dir".to_string())?
                        .clone(),
                );
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
        manifest: manifest.ok_or_else(|| "Missing --manifest".to_string())?,
        relaunch,
        user_data_dir,
    })
}

fn run_recover(args: &[OsString]) -> Result<(), String> {
    let mut target: Option<PathBuf> = None;
    let mut work: Option<PathBuf> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].to_str() {
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
            _ => return Err("Unexpected argument to recover".to_string()),
        }
    }
    let target = target.ok_or_else(|| "Missing --target".to_string())?;
    let work = work.ok_or_else(|| "Missing --work".to_string())?;
    let _lock = acquire_work_lock(&work)?;
    reconcile_previous_transaction(&target, &work)
}

fn acquire_work_lock(work: &Path) -> Result<File, String> {
    fs::create_dir_all(work)
        .map_err(|error| format!("Failed to create portable update work directory: {error}"))?;
    let lock_path = work.join(LOCK_FILE_NAME);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(0)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "Another portable update operation is active in {}: {error}",
                work.display()
            )
        })?;
    let _ = writeln!(file, "{}", std::process::id());
    Ok(file)
}

fn run_apply(args: &[OsString]) -> Result<(), String> {
    let config = parse_apply_args(args)?;
    if let Some(pid) = config.parent_pid {
        wait_for_parent_exit(pid)?;
    }

    let _lock = acquire_work_lock(&config.work)?;
    let _ = fs::remove_file(config.work.join(ERROR_FILE_NAME));

    let apply_result = (|| -> Result<(), String> {
        reconcile_previous_transaction(&config.target, &config.work)?;
        verify_staged_tree_against_manifest(&config.staged, &config.manifest)?;
        apply_staged_update(&config.staged, &config.target, &config.work)
    })();

    if let Err(error) = &apply_result {
        let _ = fs::write(config.work.join(ERROR_FILE_NAME), error.as_bytes());
    }
    apply_result?;

    if config.relaunch {
        relaunch_orca(&config.target, config.user_data_dir.as_deref())?;
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

fn parse_expected_manifest(manifest_path: &Path) -> Result<BTreeMap<String, u64>, String> {
    let raw = fs::read_to_string(manifest_path)
        .map_err(|error| format!("Could not read staged update manifest: {error}"))?;
    let mut map = BTreeMap::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (size_str, rel_path) = trimmed
            .split_once('\t')
            .ok_or_else(|| "Malformed staged update manifest entry".to_string())?;
        let size = size_str
            .parse::<u64>()
            .map_err(|_| format!("Invalid file size in staged manifest: {size_str}"))?;
        if map.insert(rel_path.to_ascii_lowercase(), size).is_some() {
            return Err(format!("Duplicate entry in staged manifest: {rel_path}"));
        }
    }
    if map.is_empty() {
        return Err("Staged update manifest is empty".to_string());
    }
    Ok(map)
}

fn walk_staged_files(
    root: &Path,
    current: &Path,
    actual: &mut BTreeMap<String, u64>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|error| format!("Failed to read staged directory {}: {error}", current.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read staged entry: {error}"))?;
        let path = entry.path();
        let meta = ensure_not_reparse_point(&path)?
            .ok_or_else(|| format!("Staged path vanished: {}", path.display()))?;
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "Staged path outside root".to_string())?
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let rel_lower = rel.to_ascii_lowercase();
        if rel_lower == DATA_DIR_NAME || rel_lower.starts_with("data/") {
            continue;
        }
        if meta.is_dir() {
            walk_staged_files(root, &path, actual)?;
        } else if meta.is_file() {
            actual.insert(rel_lower, meta.len());
        } else {
            return Err(format!("Unsupported staged file type: {}", path.display()));
        }
    }
    Ok(())
}

fn verify_staged_tree_against_manifest(staged: &Path, manifest_path: &Path) -> Result<(), String> {
    let expected = parse_expected_manifest(manifest_path)?;
    let mut actual = BTreeMap::new();
    walk_staged_files(staged, staged, &mut actual)?;
    if expected != actual {
        return Err("Staged update directory does not match the verified release manifest".to_string());
    }
    Ok(())
}

fn reconcile_previous_transaction(target: &Path, work: &Path) -> Result<(), String> {
    let backup = work.join(BACKUP_DIR_NAME);
    let tx_path = work.join(TRANSACTION_FILE_NAME);
    let tx_raw = fs::read_to_string(&tx_path).ok();

    if let Some(content) = tx_raw {
        let mut lines = content.lines();
        let state = lines.next().unwrap_or("").trim();
        if state == "committed" {
            if backup.exists() {
                fs::remove_dir_all(&backup).map_err(|error| {
                    format!(
                        "Could not remove committed portable backup at {}: {error}",
                        backup.display()
                    )
                })?;
            }
            let _ = fs::remove_file(&tx_path);
            return Ok(());
        }
        if state == "applying" {
            let entries: Vec<String> = lines
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect();
            for name in entries.iter().rev() {
                let backup_entry = backup.join(name);
                let target_entry = target.join(name);
                if backup_entry.exists() {
                    if target_entry.exists() {
                        let _ = if target_entry.is_dir() {
                            fs::remove_dir_all(&target_entry)
                        } else {
                            fs::remove_file(&target_entry)
                        };
                    }
                    rename_with_retry(&backup_entry, &target_entry)?;
                }
            }
            if backup.exists() {
                let _ = fs::remove_dir_all(&backup);
            }
            let _ = fs::remove_file(&tx_path);
            return Ok(());
        }
    }

    if backup.exists() {
        return Err(format!(
            "Unrecognized portable update backup exists at {}; refusing to overwrite recovery state",
            backup.display()
        ));
    }
    Ok(())
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
    // Move Orca.exe last during backup so the executable remains present until the final backup move.
    entries.sort_by_key(|name| name.to_string_lossy().eq_ignore_ascii_case("Orca.exe"));
    Ok(entries)
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    let deadline = Instant::now() + RENAME_RETRY_TIMEOUT;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let retryable = matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33));
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

fn write_transaction_state(work: &Path, state: &str, entries: &[OsString]) -> Result<(), String> {
    let tx_path = work.join(TRANSACTION_FILE_NAME);
    let mut body = String::from(state);
    body.push('\n');
    for entry in entries {
        body.push_str(&entry.to_string_lossy());
        body.push('\n');
    }
    fs::write(&tx_path, body.as_bytes())
        .map_err(|error| format!("Failed to persist portable transaction state: {error}"))
}

fn apply_staged_update(staged: &Path, target: &Path, work: &Path) -> Result<(), String> {
    let backup = work.join(BACKUP_DIR_NAME);
    let target_meta = ensure_not_reparse_point(target)?
        .ok_or_else(|| format!("Target directory does not exist: {}", target.display()))?;
    if !target_meta.is_dir() {
        return Err(format!("Target path is not a directory: {}", target.display()));
    }

    let entries = collect_staged_entries(staged)?;
    for name in &entries {
        ensure_not_reparse_point(&target.join(name))?;
    }

    write_transaction_state(work, "applying", &entries)?;
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
        // Install Orca.exe first so the main executable is restored immediately.
        for name in entries.iter().rev() {
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
            let _ = fs::remove_file(work.join(TRANSACTION_FILE_NAME));
            return Err(commit_error);
        }
        return Err(format!(
            "{commit_error}; rollback also encountered errors (backup retained at {}): {}",
            backup.display(),
            rollback_errors.join("; ")
        ));
    }

    // Record commit before cleanup so a locked backup directory is cleaned up on the next run instead of blocking updates.
    write_transaction_state(work, "committed", &[])?;
    if fs::remove_dir_all(&backup).is_ok() {
        let _ = fs::remove_file(work.join(TRANSACTION_FILE_NAME));
    }
    let _ = fs::remove_dir_all(staged);
    let _ = fs::remove_file(work.join("staged-manifest.txt"));
    Ok(())
}

fn relaunch_orca(target: &Path, user_data_dir: Option<&OsStr>) -> Result<(), String> {
    let exe = target.join("Orca.exe");
    let mut command = Command::new(&exe);
    if let Some(dir) = user_data_dir {
        let mut flag = OsString::from("--user-data-dir=");
        flag.push(dir);
        command.arg(flag);
    }
    command
        .current_dir(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|error| format!("Update applied, but failed to relaunch {}: {error}", exe.display()))?;
    Ok(())
}
