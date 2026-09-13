# Kotlin LSP navigation

This change extends the built-in LSP implementation in PR #1912. It requires that
implementation; it is not a configuration change for released builds without the
LSP bridge.

Install the [official Kotlin language server](https://github.com/Kotlin/kotlin-lsp)
on the machine that owns the workspace. On macOS the official installation is:

```sh
brew install JetBrains/utils/kotlin-lsp
```

For other platforms, follow the server's standalone installation instructions and
expose its launcher as `kotlin-lsp` on the execution host's PATH. Orca probes
`kotlin-lsp --version` and starts `kotlin-lsp --stdio`. For SSH workspaces, both
command discovery and the language-server process run on the SSH host. No server
binary is bundled or downloaded by Orca.

Open a `.kt` or `.kts` file in a workspace rooted at the Gradle or Maven project.
Allow the server to import/index the project before navigating:

- Cmd+click on macOS (Ctrl+click on Windows/Linux), or Go to Definition, follows a
  function call to its declaration.
- On a declaration, Monaco's default Go to Definition alternative finds references.
- The editor's Go to References / Peek References commands list usages. Selecting
  a result opens the file in the source workspace and reveals the result position.

References use the existing document synchronization, process recovery, and SSH
routing paths. Declaration inclusion follows Monaco's request context. Preview
models are isolated by source document, read through the owning host, and released
when replaced or when the source document closes. Already-open destinations use
their current editor buffers rather than stale disk contents.

Navigation is limited to file URIs inside the workspace. Dependency/JAR and other
virtual URIs are not opened. A preview request is limited to 50 destination files
and 5 million UTF-16 code units; exceeding a limit fails the request rather than
returning a partial usage list. The base LSP implementation's runtime-environment
and web-client limitations still apply. An old SSH relay without `lsp.references`
returns an unsupported-method error; requests never fall back to a local server.

## Validation

With repository dependencies installed:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts \
  src/main/lsp src/relay/lsp-handler.test.ts \
  src/renderer/src/lib/monaco-lsp.test.ts \
  src/renderer/src/lib/monaco-lsp-navigation.test.ts \
  src/renderer/src/lib/monaco-lsp-navigation-models.test.ts
pnpm typecheck
```

The automated suites exercise real stdio subprocesses with fixture servers,
relay dispatch, reconnect/failure routing, document synchronization, path handling,
and preview disposal. They do not certify a particular Kotlin server/Gradle/JDK
combination. Validate project import and cross-file navigation with a real Kotlin
server before release.
