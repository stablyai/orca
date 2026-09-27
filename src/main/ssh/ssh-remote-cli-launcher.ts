import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'

type RemoteCliInstallEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  credentialFile?: string
  hostPlatform: RemoteHostPlatform
}

type RemoteCliInstallFile = {
  path: string
  contents: string
}

export type RemoteCliInstallPlan = {
  launcherPath: string
  files: RemoteCliInstallFile[]
  postWriteCommands: string[]
}

const WINDOWS_REMOTE_CLI_LAUNCHER_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class OrcaRemoteCliLauncher
{
    private static int Main(string[] args)
    {
        try
        {
            string nodePath = RequireEnvironmentVariable("ORCA_RELAY_NODE_PATH");
            string relayDirectory = RequireEnvironmentVariable("ORCA_RELAY_DIR");
            string socketPath = RequireEnvironmentVariable("ORCA_RELAY_SOCKET_PATH");
            string credentialFile = Environment.GetEnvironmentVariable("ORCA_RELAY_CREDENTIAL_FILE");
            if (String.IsNullOrEmpty(credentialFile))
            {
                credentialFile = socketPath + ".credential";
            }
            string relayPath = Path.Combine(relayDirectory, "relay.js");

            if (!File.Exists(nodePath))
            {
                Console.Error.WriteLine("Orca SSH CLI bridge cannot find Node.js at \"{0}\"", nodePath);
                return 1;
            }
            if (!File.Exists(relayPath))
            {
                Console.Error.WriteLine("Orca SSH CLI bridge cannot find the relay at \"{0}\"", relayPath);
                return 1;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = BuildArguments(relayPath, socketPath, credentialFile, args),
                UseShellExecute = false
            };

            using (Process child = Process.Start(startInfo))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start the Orca SSH CLI bridge: {0}", error.Message);
            return 1;
        }
    }

    private static string RequireEnvironmentVariable(string name)
    {
        string value = Environment.GetEnvironmentVariable(name);
        if (String.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException(name + " is not set.");
        }
        return value;
    }

    private static string BuildArguments(string relayPath, string socketPath, string credentialFile, string[] args)
    {
        StringBuilder commandLine = new StringBuilder();
        AppendArgument(commandLine, relayPath);
        AppendArgument(commandLine, "--sock-path");
        AppendArgument(commandLine, socketPath);
        AppendArgument(commandLine, "--credential-file");
        AppendArgument(commandLine, credentialFile);
        AppendArgument(commandLine, "--orca-cli");
        foreach (string arg in args)
        {
            AppendArgument(commandLine, arg);
        }
        return commandLine.ToString();
    }

    private static void AppendArgument(StringBuilder commandLine, string value)
    {
        if (commandLine.Length > 0)
        {
            commandLine.Append(' ');
        }
        commandLine.Append(QuoteArgument(value));
    }

    private static string QuoteArgument(string value)
    {
        bool requiresQuotes = value.Length == 0;
        for (int index = 0; index < value.Length && !requiresQuotes; index += 1)
        {
            requiresQuotes = value[index] == '"' || Char.IsWhiteSpace(value[index]);
        }
        if (!requiresQuotes)
        {
            return value;
        }

        StringBuilder quoted = new StringBuilder("\"");
        int backslashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount += 1;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashCount * 2 + 1);
                quoted.Append('"');
            }
            else
            {
                quoted.Append('\\', backslashCount);
                quoted.Append(character);
            }
            backslashCount = 0;
        }

        quoted.Append('\\', backslashCount * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
`

function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function createWindowsLauncherCompileCommand(
  binDir: string,
  sourceFileName: string,
  launcherFileName: string,
  launcherPath: string,
  sourcePath: string,
  legacyShimPath: string
): string {
  // Why: legacy csc.exe mis-parses space-bearing absolute paths handed to it by
  // Windows PowerShell 5.1's native-argument quoting, so compile from the bin
  // directory and pass only the bare, space-free launcher file names.
  const compilerArgs = [
    '/nologo',
    '/target:exe',
    '/optimize+',
    '/warnaserror+',
    `/out:${launcherFileName}`,
    sourceFileName
  ]
    .map(powerShellNativeArg)
    .join(' ')
  return powerShellCommand(
    [
      `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(binDir)}`,
      '$windowsDirectory = if ($env:WINDIR) { $env:WINDIR } else { $env:SystemRoot }',
      `$compilerCandidates = @((Join-Path $windowsDirectory 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'), (Join-Path $windowsDirectory 'Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'))`,
      '$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1',
      "if (-not $compiler) { Write-Error 'Unable to find the .NET Framework C# compiler required for the Orca SSH CLI launcher.'; exit 1 }",
      `& $compiler ${compilerArgs}`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `if (-not (Test-Path -LiteralPath ${powerShellLiteral(launcherPath)} -PathType Leaf)) { Write-Error 'The Orca SSH CLI launcher compiler produced no executable.'; exit 1 }`,
      // Why: remove the legacy %* bridge only after a successful compile, so a
      // host missing csc.exe keeps its existing CLI (orca.exe shadows orca.cmd).
      `Remove-Item -LiteralPath ${powerShellLiteral(legacyShimPath)} -Force -ErrorAction SilentlyContinue`,
      `Remove-Item -LiteralPath ${powerShellLiteral(sourcePath)} -Force`
    ].join('; ')
  )
}

export function createRemoteCliInstallPlan(env: RemoteCliInstallEnv): RemoteCliInstallPlan {
  if (isWindowsRemoteHost(env.hostPlatform)) {
    const launcherFileName = 'orca.exe'
    const sourceFileName = 'orca-launcher.cs'
    const launcherPath = joinRemotePath(env.hostPlatform, env.binDir, launcherFileName)
    const sourcePath = joinRemotePath(env.hostPlatform, env.binDir, sourceFileName)
    const legacyShimPath = joinRemotePath(env.hostPlatform, env.binDir, 'orca.cmd')
    const binDir = joinRemotePath(env.hostPlatform, env.binDir)
    return {
      launcherPath,
      files: [{ path: sourcePath, contents: WINDOWS_REMOTE_CLI_LAUNCHER_SOURCE }],
      // Why: compiling on the Windows target avoids shipping an unsigned
      // cross-host binary while ensuring argv never crosses cmd.exe's parser.
      postWriteCommands: [
        createWindowsLauncherCompileCommand(
          binDir,
          sourceFileName,
          launcherFileName,
          launcherPath,
          sourcePath,
          legacyShimPath
        )
      ]
    }
  }

  const launcherPath = joinRemotePath(env.hostPlatform, env.binDir, 'orca')
  const xdgOpenPath = joinRemotePath(env.hostPlatform, env.binDir, 'xdg-open')
  return {
    launcherPath,
    files: [
      { path: xdgOpenPath, contents: POSIX_REMOTE_XDG_OPEN_SHIM },
      {
        path: launcherPath,
        contents: [
          '#!/usr/bin/env sh',
          'set -eu',
          `ORCA_RELAY_NODE_PATH=\${ORCA_RELAY_NODE_PATH:-${quoteSh(env.nodePath)}}`,
          `ORCA_RELAY_DIR=\${ORCA_RELAY_DIR:-${quoteSh(env.relayDir)}}`,
          `ORCA_RELAY_SOCKET_PATH=\${ORCA_RELAY_SOCKET_PATH:-${quoteSh(env.sockPath)}}`,
          `ORCA_RELAY_CREDENTIAL_FILE=\${ORCA_RELAY_CREDENTIAL_FILE:-${quoteSh(env.credentialFile ?? `${env.sockPath}.credential`)}}`,
          'if [ ! -S "$ORCA_RELAY_SOCKET_PATH" ]; then',
          '  echo "Orca SSH CLI bridge cannot find the relay socket: $ORCA_RELAY_SOCKET_PATH" >&2',
          '  exit 1',
          'fi',
          'exec "$ORCA_RELAY_NODE_PATH" "$ORCA_RELAY_DIR/relay.js" --sock-path "$ORCA_RELAY_SOCKET_PATH" --credential-file "$ORCA_RELAY_CREDENTIAL_FILE" --orca-cli "$@"',
          ''
        ].join('\n')
      }
    ],
    // Surface chmod failures: a non-executable launcher must fail install loudly, not silently.
    postWriteCommands: [`chmod +x ${quoteSh(launcherPath)}`, `chmod +x ${quoteSh(xdgOpenPath)}`]
  }
}

/**
 * `xdg-open` shim deployed beside the remote `orca` launcher (first on PATH in Orca terminals).
 * Why: agent CLIs open login pages with xdg-open, not $BROWSER. http(s) links go to the desktop
 * that owns this SSH session, which asks its owner before opening; if that is unavailable the
 * link is printed so it stays clickable. Anything else goes to the host's real xdg-open.
 */
export const POSIX_REMOTE_XDG_OPEN_SHIM = [
  '#!/usr/bin/env sh',
  'self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
  'case "${1:-}" in',
  '  http://*|https://*)',
  '    if "$self_dir/orca" open-url --url "$1" >/dev/null 2>&1; then exit 0; fi',
  '    printf \'Open this link: %s\\n\' "$1" >&2',
  '    exit 0',
  '    ;;',
  'esac',
  // Why a one-shot marker: however PATH spells this directory, a shim that was reached by
  // delegation must never delegate again, so a loop back to itself cannot happen.
  'if [ -n "${ORCA_XDG_OPEN_DELEGATED:-}" ]; then',
  '  echo "xdg-open: no handler for ${1:-}" >&2',
  '  exit 3',
  'fi',
  'old_ifs=$IFS',
  'IFS=:',
  'for dir in $PATH; do',
  '  IFS=$old_ifs',
  '  [ -n "$dir" ] || continue',
  // Why physical paths: `/bin/` and a symlink to this directory are both this shim.
  '  real_dir=$(CDPATH= cd -- "$dir" 2>/dev/null && pwd -P) || continue',
  '  [ "$real_dir" = "$self_dir" ] && continue',
  '  if [ -x "$dir/xdg-open" ]; then',
  '    export ORCA_XDG_OPEN_DELEGATED=1',
  '    exec "$dir/xdg-open" "$@"',
  '  fi',
  'done',
  'echo "xdg-open: no handler for ${1:-}" >&2',
  'exit 3',
  ''
].join('\n')
