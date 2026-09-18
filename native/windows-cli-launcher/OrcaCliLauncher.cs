using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class OrcaCliLauncher
{
    private static int Main(string[] args)
    {
        try
        {
            string launcherPath = typeof(OrcaCliLauncher).Assembly.Location;
            // Why: Claude Code spawns `tmux` with no shell, and Node refuses to spawn .cmd that way
            // (CVE-2024-27980), so Orca installs a copy of this launcher named tmux.exe as the shim.
            bool isTmuxShim = String.Equals(
                Path.GetFileNameWithoutExtension(launcherPath),
                "tmux",
                StringComparison.OrdinalIgnoreCase
            );
            string launcherDirectory = isTmuxShim
                ? ResolveTmuxShimLauncherDirectory()
                : Path.GetDirectoryName(launcherPath);
            if (launcherDirectory == null)
            {
                Console.Error.WriteLine(
                    "orca agent-teams tmux shim: ORCA_AGENT_TEAMS_SHIM_BIN must be an absolute path"
                );
                return 127;
            }
            string resourcesDirectory = Directory.GetParent(launcherDirectory).FullName;
            string appDirectory = Directory.GetParent(resourcesDirectory).FullName;
            string electronPath = Path.Combine(appDirectory, "Orca.exe");
            string cliPath = Path.Combine(
                resourcesDirectory,
                "app.asar.unpacked",
                "out",
                "cli",
                "index.js"
            );

            if (!File.Exists(electronPath))
            {
                Console.Error.WriteLine("Unable to locate Orca.exe next to \"{0}\"", resourcesDirectory);
                return 1;
            }

            if (!File.Exists(cliPath))
            {
                Console.Error.WriteLine("Unable to locate the Orca CLI entrypoint at \"{0}\"", cliPath);
                return 1;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = electronPath,
                Arguments = BuildArguments(cliPath, isTmuxShim ? PrependTmuxShimCommand(args) : args),
                UseShellExecute = false
            };

            // Why: launching without cmd.exe preserves embedded newlines while matching the
            // packaged batch launcher's Electron-as-Node environment contract.
            // Why: ProcessStartInfo's env copy rejects duplicate PATH/Path keys; mutating this
            // short-lived process preserves the native block for child inheritance (#12046).
            MoveEnvironmentVariable("NODE_OPTIONS", "ORCA_NODE_OPTIONS");
            MoveEnvironmentVariable("NODE_REPL_EXTERNAL_MODULE", "ORCA_NODE_REPL_EXTERNAL_MODULE");
            Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
            Environment.SetEnvironmentVariable("ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER", "1");
            string requestedCliCommand = Environment.GetEnvironmentVariable("ORCA_CLI_COMMAND");
            Environment.SetEnvironmentVariable(
                "ORCA_CLI_COMMAND",
                requestedCliCommand == "orca-ide" ? "orca-ide" : "orca"
            );

            using (Process child = Process.Start(startInfo))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start the Orca CLI: {0}", error.Message);
            return 1;
        }
    }

    // Why: the shim runs from Orca's shim directory, not from resources\bin, so its own location
    // says nothing about where the app lives. ORCA_AGENT_TEAMS_SHIM_BIN is the qualified CLI path
    // the team launch already published; anything unqualified is refused rather than guessed.
    private static string ResolveTmuxShimLauncherDirectory()
    {
        string shimBin = Environment.GetEnvironmentVariable("ORCA_AGENT_TEAMS_SHIM_BIN");
        if (String.IsNullOrEmpty(shimBin) || !IsFullyQualifiedPath(shimBin))
        {
            return null;
        }
        return Path.GetDirectoryName(shimBin);
    }

    // Why: .NET Framework has no Path.IsPathFullyQualified, and Path.IsPathRooted accepts
    // drive-relative (`C:orca.exe`) and root-relative (`\orca.exe`) paths that still resolve
    // against a working directory this shim does not control.
    private static bool IsFullyQualifiedPath(string path)
    {
        if (path.Length >= 2 && IsDirectorySeparator(path[0]) && IsDirectorySeparator(path[1]))
        {
            return true;
        }
        return path.Length >= 3
            && Char.IsLetter(path[0])
            && path[1] == ':'
            && IsDirectorySeparator(path[2]);
    }

    private static bool IsDirectorySeparator(char character)
    {
        return character == Path.DirectorySeparatorChar
            || character == Path.AltDirectorySeparatorChar;
    }

    private static string[] PrependTmuxShimCommand(string[] args)
    {
        string[] forwarded = new string[args.Length + 1];
        forwarded[0] = "agent-teams-tmux";
        args.CopyTo(forwarded, 1);
        return forwarded;
    }

    private static void MoveEnvironmentVariable(string sourceName, string targetName)
    {
        string value = Environment.GetEnvironmentVariable(sourceName);
        Environment.SetEnvironmentVariable(sourceName, null);
        // Why: a null value clears the target, matching the previous unconditional Remove.
        Environment.SetEnvironmentVariable(targetName, value);
    }

    private static string BuildArguments(string cliPath, string[] args)
    {
        StringBuilder commandLine = new StringBuilder(QuoteArgument(cliPath));
        foreach (string arg in args)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(arg));
        }
        return commandLine.ToString();
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
