use std::path::Path;

#[derive(Debug)]
pub enum BlobOutcome {
    NotFound,
    TooLarge,
    Found(Vec<u8>),
}

pub type ReadResult = Result<BlobOutcome, Box<dyn std::error::Error + Send + Sync>>;

/// Equivalent of `git show --end-of-options <rev>:<path>` for regular files:
/// raw object bytes, no filters — matching what the CLI path returns today.
///
/// `Ok(NotFound)` is returned only for a genuinely-absent path (the CLI would
/// also report it missing). Operational failures — repo open, rev resolution,
/// object read — are returned as `Err` so the N-API layer rejects and the
/// TypeScript seam falls back to the git CLI instead of serving an empty diff
/// (e.g. a repo feature gix cannot handle but the user's git can).
pub fn read_blob_at_rev_path(
    repo_path: &Path,
    rev: &str,
    path: &str,
    max_bytes: u64,
) -> ReadResult {
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
/// paths have no stage-0 entry and read as `Ok(NotFound)`, matching the CLI's
/// missing result. Operational failures return `Err` (see `read_blob_at_rev_path`).
pub fn read_blob_at_index_path(repo_path: &Path, path: &str, max_bytes: u64) -> ReadResult {
    let repo = gix::open(repo_path)?;
    // gix::open on a linked worktree resolves that worktree's private index.
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
) -> ReadResult {
    // Why: gate on the object header so a >max blob is never decompressed into
    // memory — mirrors the CLI path's maxBuffer overflow behavior.
    let header = repo.find_header(id)?;
    if header.size() > max_bytes {
        return Ok(BlobOutcome::TooLarge);
    }
    let data = repo.find_object(id)?.detach().data;
    Ok(BlobOutcome::Found(data))
}
