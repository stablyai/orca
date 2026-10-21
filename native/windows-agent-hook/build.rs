//! Embeds the Windows PE version block, application manifest, and icon.
//!
//! Why: an anonymous binary with no publisher or version scores worse under
//! antivirus heuristics, and this one runs on every agent hook event.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=ORCA_HOOK_BUILD_VERSION");
    println!("cargo:rerun-if-env-changed=ORCA_HOOK_BUILD_ICON");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    // Set by config/scripts/build-windows-agent-hook.mjs from package.json.
    let version = env::var("ORCA_HOOK_BUILD_VERSION")
        .expect("ORCA_HOOK_BUILD_VERSION must be set; build through build-windows-agent-hook.mjs");
    let (major, minor, patch) = numeric_version_parts(&version);

    let mut resource = winresource::WindowsResource::new();
    resource.set("ProductName", "Orca");
    resource.set("FileDescription", "Orca Agent Hook");
    resource.set("CompanyName", "Stably AI");
    resource.set(
        "LegalCopyright",
        "Copyright (C) Stably AI. All rights reserved.",
    );
    resource.set("InternalName", "orca-agent-hook.exe");
    resource.set("OriginalFilename", "orca-agent-hook.exe");
    resource.set("FileVersion", &format!("{major}.{minor}.{patch}.0"));
    resource.set("ProductVersion", &version);
    resource.set_version_info(
        winresource::VersionInfo::FILEVERSION,
        (major << 48) | (minor << 32) | (patch << 16),
    );
    resource.set_version_info(
        winresource::VersionInfo::PRODUCTVERSION,
        (major << 48) | (minor << 32) | (patch << 16),
    );
    resource.set_manifest_file("app.manifest");
    if let Ok(icon) = env::var("ORCA_HOOK_BUILD_ICON") {
        resource.set_icon(&icon);
    }
    resource
        .compile()
        .expect("failed to compile Windows resources");
}

/// Strips any prerelease or build suffix; the PE numeric version accepts digits only.
fn numeric_version_parts(version: &str) -> (u64, u64, u64) {
    let base = version.split(['-', '+']).next().unwrap_or_default();
    let mut parts = base.split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}
