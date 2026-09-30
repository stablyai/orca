# Account-scoped Codex MCP header helpers

Orca mirrors the host's `~/.codex/config.toml` into managed Codex homes.
Editing a copied MCP registration does not provide a persistent per-account
override. A helper that depends only on inherited `CODEX_HOME` also fails if
the native client removes that environment variable.

For a helper that accepts an explicit home, keep the canonical setting valid
for the default native client. Supply its absolute home as a whole literal
argument in a single-line helper setting:

```toml
[mcp_servers.example]
url = "http://127.0.0.1:8765/mcp"
http_headers_helper = "python /absolute/helper.py --home '/Users/example/.codex'"
```

The mirror rebases an argument exactly matching the canonical home to the
validated destination home, shell-quotes it as one argument, and preserves the
canonical setting. WSL uses Linux execution paths. Quoted paths with spaces
are supported. Substrings, executable paths, `--home=value`, shell expressions
and other settings are not rewritten. Keep the helper a simple command with
an explicit, separate home argument. No credential is copied or inferred.
The helper must reject an unregistered home and keep credentials out of output.

The default client's explicit home remains valid without Orca. Do not roll out
managed clients before the updated Orca mirror is installed. Native Windows
helper execution and each account's actual reconnect require platform
acceptance; string tests alone do not prove those boundaries.

Keep a protected backup of the previous configuration and helper. After
deployment, verify two managed homes receive distinct arguments, then reconnect
one native client and verify `tools/list` and a safe `tools/call`. Preserve
existing active clients. A standalone SDK call does not pass native-client
acceptance. Roll back the canonical setting and let the supported mirror
refresh managed homes; do not repeatedly overwrite the generated copies.
