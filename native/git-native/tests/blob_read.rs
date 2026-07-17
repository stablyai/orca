use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use git_native::blob_read::{read_blob_at_rev_path, BlobOutcome};

// Hermetic fixtures: contributor system/global git config (hooks, filters,
// fsmonitor) must not leak in. A missing global file reads as empty config,
// which keeps this Windows-safe (no /dev/null).
fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", dir.join(".test-gitconfig"))
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t");
    cmd
}

fn git(dir: &Path, args: &[&str]) {
    let status = git_cmd(dir, args).status().expect("git spawn");
    assert!(status.success(), "git {:?} failed", args);
}

fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let output = git_cmd(dir, args).output().expect("git spawn");
    assert!(output.status.success(), "git {:?} failed", args);
    String::from_utf8(output.stdout).unwrap()
}

fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().to_path_buf();
    fs::write(dir.join(".test-gitconfig"), "").unwrap();
    git(&dir, &["init", "--quiet", "-b", "main"]);
    (tmp, dir)
}

fn commit_file(dir: &Path, rel: &str, bytes: &[u8]) {
    let file = dir.join(rel);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&file, bytes).unwrap();
    git(dir, &["add", "--", rel]);
    git(dir, &["commit", "--quiet", "-m", "c"]);
}

const MAX: u64 = 10 * 1024 * 1024;

#[test]
fn reads_utf8_blob_at_head() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"hello\n");
    match read_blob_at_rev_path(&dir, "HEAD", "a.txt", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"hello\n"),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[test]
fn reads_binary_blob_bytes_exactly() {
    let (_tmp, dir) = init_repo();
    let payload: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe];
    commit_file(&dir, "img.png", &payload);
    match read_blob_at_rev_path(&dir, "HEAD", "img.png", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, payload),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[test]
fn reads_nested_path_and_explicit_commit_oid() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "sub dir/b.txt", b"v1");
    let oid = git_stdout(&dir, &["rev-parse", "HEAD"]);
    commit_file(&dir, "sub dir/b.txt", b"v2");
    match read_blob_at_rev_path(&dir, oid.trim(), "sub dir/b.txt", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"v1"),
        other => panic!("expected Found, got {:?}", other),
    }
    // A tree path must not read as a blob.
    assert!(matches!(
        read_blob_at_rev_path(&dir, "HEAD", "sub dir", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn gitlink_entry_is_not_found() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"x");
    let oid = git_stdout(&dir, &["rev-parse", "HEAD"]);
    // Stage a 160000 (gitlink) entry pointing at an existing commit oid.
    let mut child = git_cmd(&dir, &["update-index", "--index-info"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("git spawn");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("160000 {}\tsubmod\n", oid.trim()).as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success(), "update-index failed");
    git(&dir, &["commit", "--quiet", "-m", "s"]);
    assert!(matches!(
        read_blob_at_rev_path(&dir, "HEAD", "submod", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn missing_path_and_bad_rev_are_not_found() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"x");
    assert!(matches!(
        read_blob_at_rev_path(&dir, "HEAD", "nope.txt", MAX),
        BlobOutcome::NotFound
    ));
    assert!(matches!(
        read_blob_at_rev_path(&dir, "deadbeef", "a.txt", MAX),
        BlobOutcome::NotFound
    ));
    assert!(matches!(
        read_blob_at_rev_path(Path::new("/nonexistent-repo"), "HEAD", "a.txt", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn oversized_blob_is_too_large() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "big.bin", &[0u8; 32]);
    // A blob larger than max_bytes must report TooLarge, not Found or an error.
    assert!(matches!(
        read_blob_at_rev_path(&dir, "HEAD", "big.bin", 16),
        BlobOutcome::TooLarge
    ));
}

#[test]
fn blob_exactly_at_size_limit_is_found() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "b.txt", b"123456");
    // Node maxBuffer parity: only over-limit is TooLarge, at-limit succeeds.
    match read_blob_at_rev_path(&dir, "HEAD", "b.txt", 6) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"123456"),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[test]
fn executable_blob_reads_bytes() {
    let (_tmp, dir) = init_repo();
    fs::write(dir.join("run.sh"), b"#!/bin/sh\n").unwrap();
    git(&dir, &["add", "--", "run.sh"]);
    // --chmod stages mode 100755 regardless of host filesystem semantics.
    git(&dir, &["update-index", "--chmod=+x", "--", "run.sh"]);
    git(&dir, &["commit", "--quiet", "-m", "x"]);
    match read_blob_at_rev_path(&dir, "HEAD", "run.sh", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"#!/bin/sh\n"),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[test]
fn empty_committed_file_is_found_empty() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "empty.txt", b"");
    match read_blob_at_rev_path(&dir, "HEAD", "empty.txt", MAX) {
        BlobOutcome::Found(bytes) => assert!(bytes.is_empty(), "expected empty bytes"),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[cfg(unix)]
#[test]
fn symlink_entry_reads_target_bytes() {
    // Matches `git show HEAD:link` which prints the link target blob.
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "real.txt", b"data");
    std::os::unix::fs::symlink("real.txt", dir.join("link")).unwrap();
    git(&dir, &["add", "--", "link"]);
    git(&dir, &["commit", "--quiet", "-m", "l"]);
    match read_blob_at_rev_path(&dir, "HEAD", "link", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"real.txt"),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[test]
fn reads_from_packed_objects() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"packed");
    git(&dir, &["gc", "--quiet"]);
    match read_blob_at_rev_path(&dir, "HEAD", "a.txt", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"packed"),
        other => panic!("expected Found, got {:?}", other),
    }
}

#[test]
fn reads_head_in_linked_worktree() {
    // Repo and linked worktree share one TempDir root so nothing leaks on drop.
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("repo");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join(".test-gitconfig"), "").unwrap();
    git(&dir, &["init", "--quiet", "-b", "main"]);
    commit_file(&dir, "a.txt", b"main-content");
    let wt = tmp.path().join("linked-wt");
    git(
        &dir,
        &[
            "worktree",
            "add",
            "--quiet",
            wt.to_str().unwrap(),
            "-b",
            "feature",
        ],
    );
    match read_blob_at_rev_path(&wt, "HEAD", "a.txt", MAX) {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, b"main-content"),
        other => panic!("expected Found, got {:?}", other),
    }
}
