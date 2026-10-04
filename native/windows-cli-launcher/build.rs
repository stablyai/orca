//! Embeds the Windows PE version block, application manifest, and icon.
//!
//! Why this matters beyond cosmetics: an anonymous binary with no publisher,
//! no version, and no declared execution level scores worse under antivirus
//! heuristics than an identified one, and several vendor submission portals
//! reject a sample that carries no version metadata at all.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-env-changed=ORCA_LAUNCHER_VERSION");
    println!("cargo:rerun-if-env-changed=ORCA_LAUNCHER_ICON");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    // Set by config/scripts/build-windows-cli-launcher.mjs from package.json, so
    // the launcher always reports the release it shipped in.
    let version = env::var("ORCA_LAUNCHER_VERSION")
        .expect("ORCA_LAUNCHER_VERSION must be set; build through build-windows-cli-launcher.mjs");
    let (major, minor, patch) = numeric_version_parts(&version);

    let mut resource = winresource::WindowsResource::new();
    resource.set("ProductName", "Orca");
    resource.set("FileDescription", "Orca CLI Launcher");
    resource.set("CompanyName", "Stably AI");
    resource.set(
        "LegalCopyright",
        "Copyright (C) Stably AI. All rights reserved.",
    );
    resource.set("InternalName", "orca.exe");
    resource.set("OriginalFilename", "orca.exe");
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
    if let Ok(icon) = env::var("ORCA_LAUNCHER_ICON") {
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
