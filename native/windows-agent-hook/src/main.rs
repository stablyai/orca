//! Orca's native Windows agent hook, registered as `orca-agent-hook.exe <agent>`: answers
//! `{}`, then posts the hook payload to Orca's loopback listener and waits for the reply,
//! so status events arrive in the order the agent emitted them.
//!
//! Why native: the `.cmd` form costs a cmd.exe start (plus the user's AutoRun) and
//! a curl.exe start on every event, and only an executable runs the same way under
//! Git Bash, PowerShell, and a direct CreateProcess (#20913). The `claude` contract
//! mirrors the managed Windows script in src/main/claude/hook-script.ts.

use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

// Same caps as the curl form's `--connect-timeout 0.5 --max-time 1.5`.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const TOTAL_TIMEOUT: Duration = Duration::from_millis(1500);
const ENDPOINT_FILE_BYTE_LIMIT: u64 = 64 * 1024;

/// What one agent's hooks report under, and which of its env vars veto reporting.
struct Agent {
    source: &'static str,
    /// Set means the event is not this pane's to report: exit without owning stdin.
    exit_vars: &'static [&'static str],
}

fn agent(name: &str) -> Option<Agent> {
    match name {
        "claude" => Some(Agent {
            source: "claude",
            // CLAUDE_JOB_DIR: a backgrounded session inherited the dispatching pane's env (#9236).
            // Grok and Devin import .claude hooks; only their own hooks report those events, and
            // a drain-to-EOF would hang on a caller that holds stdin open (#24907).
            exit_vars: &["CLAUDE_JOB_DIR", "GROK_HOOK_EVENT", "DEVIN_PROJECT_DIR"],
        }),
        _ => None,
    }
}

fn main() {
    let mut stdout = io::stdout();
    // Why first: Claude-compatible permission hooks fail closed on empty stdout (#14818).
    let _ = stdout.write_all(b"{}\r\n");
    let _ = stdout.flush();
    // Why no stdin for an unknown agent: a newer Orca may register one this copy predates.
    if let Some(agent) = env::args_os().nth(1).and_then(|arg| agent(arg.to_str()?)) {
        run(&agent);
    }
    // Why always 0: a hook failure must never block or fail the agent's tool call.
    std::process::exit(0);
}

fn run(agent: &Agent) {
    // Why: refresh the listener coordinates for terminals that survived an Orca restart.
    let endpoint = read_endpoint_file();
    let coordinate = |key: &str| endpoint_value(&endpoint, key).unwrap_or_else(|| var(key));
    let port = coordinate("ORCA_AGENT_HOOK_PORT");
    let token = coordinate("ORCA_AGENT_HOOK_TOKEN");
    // Why (#11549): without Orca's env the hook ran outside an Orca pane, where the caller
    // may abandon stdin; exit before reading it.
    if port.is_empty() || token.is_empty() || var("ORCA_PANE_KEY").is_empty() {
        return;
    }
    let is_set = |name: &&str| !var(name).is_empty();
    if agent.exit_vars.iter().any(is_set) {
        return;
    }
    let mut payload = Vec::new();
    let _ = io::stdin().lock().read_to_end(&mut payload);
    let form = [
        ("paneKey", var("ORCA_PANE_KEY")),
        ("tabId", var("ORCA_TAB_ID")),
        ("launchToken", var("ORCA_AGENT_LAUNCH_TOKEN")),
        ("worktreeId", var("ORCA_WORKTREE_ID")),
        ("env", coordinate("ORCA_AGENT_HOOK_ENV")),
        ("version", coordinate("ORCA_AGENT_HOOK_VERSION")),
    ];
    post(agent.source, &port, &token, &form, &payload);
}

fn var(name: &str) -> String {
    env::var_os(name)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The file src/shared/agent-hook-listener/endpoint-publication.ts writes, or "" if unreadable.
fn read_endpoint_file() -> String {
    let mut text = String::new();
    let read = File::open(var("ORCA_AGENT_HOOK_ENDPOINT")).and_then(|file| {
        file.take(ENDPOINT_FILE_BYTE_LIMIT)
            .read_to_string(&mut text)
    });
    if read.is_err() {
        text.clear();
    }
    text
}

/// The last `set KEY=VALUE` for `key`, as `call` would leave it; `lines` strips the CRLF.
fn endpoint_value(text: &str, key: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let assignment = line
            .get(..4)
            .filter(|prefix| prefix.eq_ignore_ascii_case("set "))
            .and(line.get(4..))?;
        let (name, value) = assignment.split_once('=')?;
        (name == key).then(|| value.to_string())
    })
}

fn post(source: &str, port: &str, token: &str, form: &[(&str, String)], payload: &[u8]) {
    let Ok(port) = port.parse::<u16>() else {
        return;
    };
    // A header value cannot carry control characters; such a token never authenticates anyway.
    if port == 0 || token.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return;
    }
    let mut body = Vec::with_capacity(payload.len() * 3 / 2 + 512);
    for (name, value) in form {
        append_form_field(&mut body, name, value.as_bytes());
        body.push(b'&');
    }
    append_form_field(&mut body, "payload", payload);
    let mut request = format!(
        "POST /hook/{source} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Content-Type: application/x-www-form-urlencoded\r\n\
         X-Orca-Agent-Hook-Token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(&body);

    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return;
    };
    // Why wait for the reply: the listener applies the event before answering, and an exit
    // before that would let the agent's next event overtake this one.
    if arm(&stream, deadline) && stream.write_all(&request).is_ok() && arm(&stream, deadline) {
        let _ = io::copy(&mut stream, &mut io::sink());
    }
}

/// Bounds the next socket calls by what is left of the deadline; false once it has passed.
fn arm(stream: &TcpStream, deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    !remaining.is_zero()
        && stream.set_read_timeout(Some(remaining)).is_ok()
        && stream.set_write_timeout(Some(remaining)).is_ok()
}

/// `name=value` with the value percent-encoded exactly as curl's `--data-urlencode` does.
fn append_form_field(body: &mut Vec<u8>, name: &str, value: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    body.extend_from_slice(name.as_bytes());
    body.push(b'=');
    for &byte in value {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            body.push(byte);
        } else {
            body.extend_from_slice(&[
                b'%',
                HEX[usize::from(byte >> 4)],
                HEX[usize::from(byte & 15)],
            ]);
        }
    }
}
