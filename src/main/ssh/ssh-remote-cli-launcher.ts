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

internal static class MCodeRemoteCliLauncher
{
    private static int Main(string[] args)
    {
        try
        {
            string nodePath = RequireEnvironmentVariable("MCODE_RELAY_NODE_PATH");
            string relayDirectory = RequireEnvironmentVariable("MCODE_RELAY_DIR");
            string socketPath = RequireEnvironmentVariable("MCODE_RELAY_SOCKET_PATH");
            string credentialFile = Environment.GetEnvironmentVariable("MCODE_RELAY_CREDENTIAL_FILE");
            if (String.IsNullOrEmpty(credentialFile))
            {
                credentialFile = socketPath + ".credential";
            }
            string relayPath = Path.Combine(relayDirectory, "relay.js");

            if (!File.Exists(nodePath))
            {
                Console.Error.WriteLine("MCode SSH CLI bridge cannot find Node.js at \"{0}\"", nodePath);
                return 1;
            }
            if (!File.Exists(relayPath))
            {
                Console.Error.WriteLine("MCode SSH CLI bridge cannot find the relay at \"{0}\"", relayPath);
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
            Console.Error.WriteLine("Unable to start the MCode SSH CLI bridge: {0}", error.Message);
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
        AppendArgument(commandLine, "--mcode-cli");
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
      "if (-not $compiler) { Write-Error 'Unable to find the .NET Framework C# compiler required for the MCode SSH CLI launcher.'; exit 1 }",
      `& $compiler ${compilerArgs}`,
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      `if (-not (Test-Path -LiteralPath ${powerShellLiteral(launcherPath)} -PathType Leaf)) { Write-Error 'The MCode SSH CLI launcher compiler produced no executable.'; exit 1 }`,
      // Why: remove the legacy %* bridge only after a successful compile, so a
      // host missing csc.exe keeps its existing CLI (mcode.exe shadows mcode.cmd).
      `Remove-Item -LiteralPath ${powerShellLiteral(legacyShimPath)} -Force -ErrorAction SilentlyContinue`,
      `Remove-Item -LiteralPath ${powerShellLiteral(sourcePath)} -Force`
    ].join('; ')
  )
}

export function createRemoteCliInstallPlan(env: RemoteCliInstallEnv): RemoteCliInstallPlan {
  if (isWindowsRemoteHost(env.hostPlatform)) {
    const launcherFileName = 'mcode.exe'
    const sourceFileName = 'mcode-launcher.cs'
    const launcherPath = joinRemotePath(env.hostPlatform, env.binDir, launcherFileName)
    const sourcePath = joinRemotePath(env.hostPlatform, env.binDir, sourceFileName)
    const legacyShimPath = joinRemotePath(env.hostPlatform, env.binDir, 'mcode.cmd')
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

  const launcherPath = joinRemotePath(env.hostPlatform, env.binDir, 'mcode')
  return {
    launcherPath,
    files: [
      {
        path: launcherPath,
        contents: [
          '#!/usr/bin/env sh',
          'set -eu',
          `MCODE_RELAY_NODE_PATH=\${MCODE_RELAY_NODE_PATH:-${quoteSh(env.nodePath)}}`,
          `MCODE_RELAY_DIR=\${MCODE_RELAY_DIR:-${quoteSh(env.relayDir)}}`,
          `MCODE_RELAY_SOCKET_PATH=\${MCODE_RELAY_SOCKET_PATH:-${quoteSh(env.sockPath)}}`,
          `MCODE_RELAY_CREDENTIAL_FILE=\${MCODE_RELAY_CREDENTIAL_FILE:-${quoteSh(env.credentialFile ?? `${env.sockPath}.credential`)}}`,
          'if [ ! -S "$MCODE_RELAY_SOCKET_PATH" ]; then',
          '  echo "MCode SSH CLI bridge cannot find the relay socket: $MCODE_RELAY_SOCKET_PATH" >&2',
          '  exit 1',
          'fi',
          'exec "$MCODE_RELAY_NODE_PATH" "$MCODE_RELAY_DIR/relay.js" --sock-path "$MCODE_RELAY_SOCKET_PATH" --credential-file "$MCODE_RELAY_CREDENTIAL_FILE" --mcode-cli "$@"',
          ''
        ].join('\n')
      }
    ],
    // Surface chmod failures: a non-executable launcher must fail install loudly, not silently.
    postWriteCommands: [`chmod +x ${quoteSh(launcherPath)}`]
  }
}
