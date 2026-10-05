//! Launches the Orca CLI by running the packaged Electron binary as Node.
//!
//! Why a native binary rather than the `.cmd` alone: `cmd.exe` reparses `%*` and
//! executes or truncates embedded newlines, so orchestration message bodies
//! cannot survive it (#8374). `orca.cmd` refuses those subcommands and defers
//! here.
//!
//! Why not a managed assembly: a small freshly-compiled MSIL image in a
//! user-writable directory that mutates environment variables and proxies a
//! child process is the shape antivirus MSIL heuristics are trained on, and it
//! was flagged as exactly that across several vendors (#23383).

use std::env;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

fn main() {
    let launcher = match env::current_exe() {
        Ok(path) => path,
        Err(error) => fail(&format!("Unable to start the Orca CLI: {error}")),
    };

    let Some(resources_directory) = launcher.parent().and_then(Path::parent) else {
        fail(&format!(
            "Unable to locate Orca.exe next to \"{}\"",
            launcher.display()
        ))
    };
    let Some(app_directory) = resources_directory.parent() else {
        fail(&format!(
            "Unable to locate Orca.exe next to \"{}\"",
            resources_directory.display()
        ))
    };

    let electron_path = app_directory.join("Orca.exe");
    if !electron_path.is_file() {
        fail(&format!(
            "Unable to locate Orca.exe next to \"{}\"",
            resources_directory.display()
        ));
    }

    let cli_path: PathBuf = resources_directory
        .join("app.asar.unpacked")
        .join("out")
        .join("cli")
        .join("index.js");
    if !cli_path.is_file() {
        fail(&format!(
            "Unable to locate the Orca CLI entrypoint at \"{}\"",
            cli_path.display()
        ));
    }

    // Why mutate this process rather than hand the child an environment map:
    // an explicit map collapses a block carrying both PATH and Path into one
    // entry, which is what killed the CLI in #12046. Leaving the map untouched
    // makes the child inherit our block verbatim.
    move_environment_variable("NODE_OPTIONS", "ORCA_NODE_OPTIONS");
    move_environment_variable(
        "NODE_REPL_EXTERNAL_MODULE",
        "ORCA_NODE_REPL_EXTERNAL_MODULE",
    );
    env::set_var("ELECTRON_RUN_AS_NODE", "1");
    env::set_var("ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER", "1");
    let requested_command = env::var("ORCA_CLI_COMMAND").unwrap_or_default();
    env::set_var(
        "ORCA_CLI_COMMAND",
        if requested_command == "orca-ide" {
            "orca-ide"
        } else {
            "orca"
        },
    );

    // Why: an Orca parent can hand us a Crashpad pipe that no longer exists, and the
    // Electron child then logs a registration error on stderr on every run even though
    // the command succeeds (#19792).
    env::remove_var("CHROME_CRASHPAD_PIPE_NAME");

    // Each argument stays its own argv entry, so a body holding newlines reaches
    // the CLI intact.
    let mut command = Command::new(&electron_path);
    command.arg(&cli_path).args(env::args_os().skip(1));

    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => fail(&format!("Unable to start the Orca CLI: {error}")),
    }
}

fn move_environment_variable(source_name: &str, target_name: &str) {
    match env::var_os(source_name) {
        // A missing source clears the target, so a stale value cannot leak in.
        None => env::remove_var(target_name),
        Some(value) => {
            env::remove_var(source_name);
            env::set_var(target_name, value);
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    exit(1)
}
