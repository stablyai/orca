use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;

pub mod blob_read;

use blob_read::BlobOutcome;

/// Health probe: proves the addon loaded and N-API dispatch works before the
/// loader trusts it for real reads.
#[napi]
pub fn native_git_ping() -> u32 {
    1
}

#[napi(object)]
pub struct NativeBlobResult {
    pub found: bool,
    pub too_large: bool,
    pub data: Option<Buffer>,
}

fn to_result(outcome: BlobOutcome) -> NativeBlobResult {
    match outcome {
        BlobOutcome::NotFound => NativeBlobResult {
            found: false,
            too_large: false,
            data: None,
        },
        BlobOutcome::TooLarge => NativeBlobResult {
            found: true,
            too_large: true,
            data: None,
        },
        BlobOutcome::Found(bytes) => NativeBlobResult {
            found: true,
            too_large: false,
            data: Some(bytes.into()),
        },
    }
}

pub struct RevPathTask {
    repo_path: String,
    rev: String,
    path: String,
    max_bytes: u32,
}

impl Task for RevPathTask {
    type Output = BlobOutcome;
    type JsValue = NativeBlobResult;

    fn compute(&mut self) -> Result<Self::Output> {
        // Operational failures (repo open / rev / object read) reject so the TS
        // seam falls back to the git CLI; only genuinely-absent paths resolve as
        // NotFound. See blob_read::read_blob_at_rev_path.
        blob_read::read_blob_at_rev_path(
            Path::new(&self.repo_path),
            &self.rev,
            &self.path,
            u64::from(self.max_bytes),
        )
        .map_err(|e| Error::from_reason(e.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(to_result(output))
    }
}

#[napi(ts_return_type = "Promise<NativeBlobResult>")]
pub fn read_blob_at_rev_path(
    repo_path: String,
    rev: String,
    path: String,
    max_bytes: u32,
) -> AsyncTask<RevPathTask> {
    AsyncTask::new(RevPathTask {
        repo_path,
        rev,
        path,
        max_bytes,
    })
}

pub struct IndexPathTask {
    repo_path: String,
    path: String,
    max_bytes: u32,
}

impl Task for IndexPathTask {
    type Output = BlobOutcome;
    type JsValue = NativeBlobResult;

    fn compute(&mut self) -> Result<Self::Output> {
        // Operational failures reject so the TS seam falls back to the git CLI;
        // only genuinely-absent paths resolve as NotFound. See
        // blob_read::read_blob_at_index_path.
        blob_read::read_blob_at_index_path(
            Path::new(&self.repo_path),
            &self.path,
            u64::from(self.max_bytes),
        )
        .map_err(|e| Error::from_reason(e.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(to_result(output))
    }
}

#[napi(ts_return_type = "Promise<NativeBlobResult>")]
pub fn read_blob_at_index_path(
    repo_path: String,
    path: String,
    max_bytes: u32,
) -> AsyncTask<IndexPathTask> {
    AsyncTask::new(IndexPathTask {
        repo_path,
        path,
        max_bytes,
    })
}
