use napi_derive::napi;

pub mod blob_read;

/// Health probe: proves the addon loaded and N-API dispatch works before the
/// loader trusts it for real reads.
#[napi]
pub fn native_git_ping() -> u32 {
    1
}
