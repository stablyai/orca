use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use git_native::blob_read::{read_blob_at_index_path, read_blob_at_rev_path, BlobOutcome};

// Hermetic fixtures: contributor system/global git config (hooks, filters,
// fsmonitor) must not leak in. The global path lives under .git/ and is never
// created: git reads a missing file as empty config (also through a linked
// worktree's .git *file*), and .git/ contents can never be staged by `git add .`.
fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", dir.join(".git").join("test-gitconfig"))
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

// Stage a 160000 (gitlink) entry at `rel` pointing at an existing commit oid.
fn stage_gitlink(dir: &Path, oid: &str, rel: &str) {
    let mut child = git_cmd(dir, &["update-index", "--index-info"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("git spawn");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("160000 {}\t{}\n", oid.trim(), rel).as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success(), "update-index failed");
}

// track_caller: panic locations point at the failing test, not this helper.
#[track_caller]
fn assert_found(outcome: BlobOutcome, expected: &[u8]) {
    match outcome {
        BlobOutcome::Found(bytes) => assert_eq!(bytes, expected),
        other => panic!("expected Found, got {:?}", other),
    }
}

const MAX: u64 = 10 * 1024 * 1024;

#[test]
fn reads_utf8_blob_at_head() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"hello\n");
    assert_found(
        read_blob_at_rev_path(&dir, "HEAD", "a.txt", MAX),
        b"hello\n",
    );
}

#[test]
fn reads_binary_blob_bytes_exactly() {
    let (_tmp, dir) = init_repo();
    let payload: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe];
    commit_file(&dir, "img.png", &payload);
    assert_found(
        read_blob_at_rev_path(&dir, "HEAD", "img.png", MAX),
        &payload,
    );
}

#[test]
fn reads_nested_path_and_explicit_commit_oid() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "sub dir/b.txt", b"v1");
    let oid = git_stdout(&dir, &["rev-parse", "HEAD"]);
    commit_file(&dir, "sub dir/b.txt", b"v2");
    assert_found(
        read_blob_at_rev_path(&dir, oid.trim(), "sub dir/b.txt", MAX),
        b"v1",
    );
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
    stage_gitlink(&dir, &oid, "submod");
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
    assert_found(read_blob_at_rev_path(&dir, "HEAD", "b.txt", 6), b"123456");
}

#[test]
fn executable_blob_reads_bytes() {
    let (_tmp, dir) = init_repo();
    fs::write(dir.join("run.sh"), b"#!/bin/sh\n").unwrap();
    git(&dir, &["add", "--", "run.sh"]);
    // --chmod stages mode 100755 regardless of host filesystem semantics.
    git(&dir, &["update-index", "--chmod=+x", "--", "run.sh"]);
    git(&dir, &["commit", "--quiet", "-m", "x"]);
    assert_found(
        read_blob_at_rev_path(&dir, "HEAD", "run.sh", MAX),
        b"#!/bin/sh\n",
    );
}

#[test]
fn empty_committed_file_is_found_empty() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "empty.txt", b"");
    assert_found(read_blob_at_rev_path(&dir, "HEAD", "empty.txt", MAX), b"");
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
    assert_found(
        read_blob_at_rev_path(&dir, "HEAD", "link", MAX),
        b"real.txt",
    );
}

#[test]
fn reads_from_packed_objects() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"packed");
    git(&dir, &["gc", "--quiet"]);
    assert_found(read_blob_at_rev_path(&dir, "HEAD", "a.txt", MAX), b"packed");
}

#[test]
fn reads_head_in_linked_worktree() {
    // Repo and linked worktree share one TempDir root so nothing leaks on drop.
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("repo");
    fs::create_dir(&dir).unwrap();
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
    assert_found(
        read_blob_at_rev_path(&wt, "HEAD", "a.txt", MAX),
        b"main-content",
    );
}

#[test]
fn index_read_returns_staged_content_not_head() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"committed");
    fs::write(dir.join("a.txt"), b"staged").unwrap();
    git(&dir, &["add", "--", "a.txt"]);
    assert_found(read_blob_at_index_path(&dir, "a.txt", MAX), b"staged");
}

#[test]
fn index_read_finds_newly_added_file_absent_from_head() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"x");
    fs::write(dir.join("new.txt"), b"added-only").unwrap();
    git(&dir, &["add", "--", "new.txt"]);
    assert_found(read_blob_at_index_path(&dir, "new.txt", MAX), b"added-only");
    // And HEAD does not have it:
    assert!(matches!(
        read_blob_at_rev_path(&dir, "HEAD", "new.txt", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn index_read_missing_path_is_not_found() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"x");
    assert!(matches!(
        read_blob_at_index_path(&dir, "nope.txt", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn index_read_in_fresh_repo_without_index_file_is_not_found() {
    // `git init` creates no index file; the open-index error must read as NotFound.
    let (_tmp, dir) = init_repo();
    assert!(matches!(
        read_blob_at_index_path(&dir, "a.txt", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn unmerged_path_has_no_stage_zero_entry() {
    // `git show :conflicted` fails with "is unmerged" → Orca maps to exists:false.
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "c.txt", b"base");
    git(&dir, &["checkout", "--quiet", "-b", "side"]);
    commit_file(&dir, "c.txt", b"side");
    git(&dir, &["checkout", "--quiet", "main"]);
    commit_file(&dir, "c.txt", b"main");
    // .output() rather than .status() so conflict chatter stays out of test output.
    let merged = git_cmd(&dir, &["merge", "side"]).output().unwrap();
    assert!(!merged.status.success(), "merge should conflict");
    assert!(matches!(
        read_blob_at_index_path(&dir, "c.txt", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn staged_gitlink_entry_is_not_found_in_index() {
    // Same contract as rev reads: gitlinks are not blob-readable.
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"x");
    let oid = git_stdout(&dir, &["rev-parse", "HEAD"]);
    stage_gitlink(&dir, &oid, "submod");
    assert!(matches!(
        read_blob_at_index_path(&dir, "submod", MAX),
        BlobOutcome::NotFound
    ));
}

#[test]
fn index_read_empty_staged_file_is_found_empty() {
    let (_tmp, dir) = init_repo();
    commit_file(&dir, "a.txt", b"x");
    fs::write(dir.join("empty.txt"), b"").unwrap();
    git(&dir, &["add", "--", "empty.txt"]);
    assert_found(read_blob_at_index_path(&dir, "empty.txt", MAX), b"");
}

#[test]
fn index_read_size_boundary_matches_rev_reads() {
    let (_tmp, dir) = init_repo();
    fs::write(dir.join("big.bin"), [7u8; 32]).unwrap();
    git(&dir, &["add", "--", "big.bin"]);
    // Node maxBuffer parity via shared read_blob_bounded: over-limit is
    // TooLarge, exactly-at-limit succeeds.
    assert!(matches!(
        read_blob_at_index_path(&dir, "big.bin", 16),
        BlobOutcome::TooLarge
    ));
    assert_found(read_blob_at_index_path(&dir, "big.bin", 32), &[7u8; 32]);
}

#[test]
fn index_read_uses_linked_worktree_private_index() {
    // Repo and linked worktree share one TempDir root so nothing leaks on drop.
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("repo");
    fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "--quiet", "-b", "main"]);
    commit_file(&dir, "a.txt", b"main");
    let wt = tmp.path().join("linked-wt");
    git(
        &dir,
        &[
            "worktree",
            "add",
            "--quiet",
            wt.to_str().unwrap(),
            "-b",
            "wt-branch",
        ],
    );
    fs::write(wt.join("a.txt"), b"wt-staged").unwrap();
    git(&wt, &["add", "--", "a.txt"]);
    // The linked worktree's index has the staged bytes; the main worktree's does not.
    assert_found(read_blob_at_index_path(&wt, "a.txt", MAX), b"wt-staged");
    assert_found(read_blob_at_index_path(&dir, "a.txt", MAX), b"main");
}
