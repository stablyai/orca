use std::path::Path;

#[derive(Debug)]
pub enum BlobOutcome {
    NotFound,
    TooLarge,
    Found(Vec<u8>),
}

/// Equivalent of `git show --end-of-options <rev>:<path>` for regular files:
/// raw object bytes, no filters — matching what the CLI path returns today.
pub fn read_blob_at_rev_path(
    repo_path: &Path,
    rev: &str,
    path: &str,
    max_bytes: u64,
) -> BlobOutcome {
    match try_read_rev_path(repo_path, rev, path, max_bytes) {
        Ok(outcome) => outcome,
        Err(_) => BlobOutcome::NotFound,
    }
}

fn try_read_rev_path(
    repo_path: &Path,
    rev: &str,
    path: &str,
    max_bytes: u64,
) -> Result<BlobOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let repo = gix::open(repo_path)?;
    let object = repo.rev_parse_single(rev)?.object()?;
    let tree = object.peel_to_tree()?;
    let Some(entry) = tree.lookup_entry_by_path(path)? else {
        return Ok(BlobOutcome::NotFound);
    };
    let mode = entry.mode();
    // Trees and commits (gitlinks) are not blob-readable. NotFound intentionally
    // diverges from `git show`, which prints the commit when a gitlink OID is
    // locally resolvable; Orca routes submodules away before this read.
    if !(mode.is_blob() || mode.is_link()) {
        return Ok(BlobOutcome::NotFound);
    }
    read_blob_bounded(&repo, entry.object_id(), max_bytes)
}

/// Equivalent of `git show :<path>`: the stage-0 index entry's blob. Unmerged
/// paths have no stage-0 entry and read as NotFound, matching the CLI error path.
pub fn read_blob_at_index_path(repo_path: &Path, path: &str, max_bytes: u64) -> BlobOutcome {
    match try_read_index_path(repo_path, path, max_bytes) {
        Ok(outcome) => outcome,
        Err(_) => BlobOutcome::NotFound,
    }
}

fn try_read_index_path(
    repo_path: &Path,
    path: &str,
    max_bytes: u64,
) -> Result<BlobOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let repo = gix::open(repo_path)?;
    // gix::open on a linked worktree resolves that worktree's private index;
    // a fresh repo has no index file and errors here, reading as NotFound.
    let index = repo.index()?;
    let Some(entry) =
        index.entry_by_path_and_stage(path.into(), gix::index::entry::Stage::Unconflicted)
    else {
        return Ok(BlobOutcome::NotFound);
    };
    // Gitlinks and sparse-dir entries are not blob-readable, same as rev reads.
    if entry.mode.is_submodule() || entry.mode.is_sparse() {
        return Ok(BlobOutcome::NotFound);
    }
    read_blob_bounded(&repo, entry.id, max_bytes)
}

pub(crate) fn read_blob_bounded(
    repo: &gix::Repository,
    id: gix::ObjectId,
    max_bytes: u64,
) -> Result<BlobOutcome, Box<dyn std::error::Error + Send + Sync>> {
    // Why: gate on the object header so a >max blob is never decompressed into
    // memory — mirrors the CLI path's maxBuffer overflow behavior.
    let header = repo.find_header(id)?;
    if header.size() > max_bytes {
        return Ok(BlobOutcome::TooLarge);
    }
    let data = repo.find_object(id)?.detach().data;
    Ok(BlobOutcome::Found(data))
}
