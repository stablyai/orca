import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'

type RemoteCliInstallEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
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
                Arguments = BuildArguments(relayPath, socketPath, args),
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

    private static string BuildArguments(string relayPath, string socketPath, string[] args)
    {
        StringBuilder commandLine = new StringBuilder();
        AppendArgument(commandLine, relayPath);
        AppendArgument(commandLine, "--sock-path");
        AppendArgument(commandLine, socketPath);
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
      // Why: an upgrade must not leave the old %* batch bridge callable when
      // compiler discovery fails; losing the convenience CLI is safer.
      `Remove-Item -LiteralPath ${powerShellLiteral(legacyShimPath)} -Force -ErrorAction SilentlyContinue`,
      `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(binDir)}`,
      '$windowsDirectory = if ($env:WINDIR) { $env:WINDIR } else { $env:SystemRoot }',
      `$compilerCandidates = @((Join-Path $windowsDirectory 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'), (Join-Path $windowsDirectory 'Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'))`,
      '$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1',
      "if (-not $compiler) { Write-Error 'Unable to find the .NET Framework C# compiler required for the Orca SSH CLI launcher.'; exit 1 }",
      `& $compiler ${compilerArgs}`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `if (-not (Test-Path -LiteralPath ${powerShellLiteral(launcherPath)} -PathType Leaf)) { Write-Error 'The Orca SSH CLI launcher compiler produced no executable.'; exit 1 }`,
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
  return {
    launcherPath,
    files: [
      {
        path: launcherPath,
        contents: [
          '#!/usr/bin/env sh',
          'set -eu',
          `ORCA_RELAY_NODE_PATH=\${ORCA_RELAY_NODE_PATH:-${quoteSh(env.nodePath)}}`,
          `ORCA_RELAY_DIR=\${ORCA_RELAY_DIR:-${quoteSh(env.relayDir)}}`,
          `ORCA_RELAY_SOCKET_PATH=\${ORCA_RELAY_SOCKET_PATH:-${quoteSh(env.sockPath)}}`,
          'if [ ! -S "$ORCA_RELAY_SOCKET_PATH" ]; then',
          '  echo "Orca SSH CLI bridge cannot find the relay socket: $ORCA_RELAY_SOCKET_PATH" >&2',
          '  exit 1',
          'fi',
          'exec "$ORCA_RELAY_NODE_PATH" "$ORCA_RELAY_DIR/relay.js" --sock-path "$ORCA_RELAY_SOCKET_PATH" --orca-cli "$@"',
          ''
        ].join('\n')
      }
    ],
    // Surface chmod failures: a non-executable launcher must fail install loudly, not silently.
    postWriteCommands: [`chmod +x ${quoteSh(launcherPath)}`]
  }
}
