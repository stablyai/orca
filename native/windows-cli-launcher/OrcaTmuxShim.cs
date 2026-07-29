using System;
using System.Diagnostics;

// Why: Windows CreateProcess appends .exe but not .cmd, so a bare-name spawn("tmux")
// reaches the wrong multiplexer when psmux, git-for-Windows tmux, or another port is on PATH.
// Being an .exe on PATH ahead of those alternatives is the whole point of this shim.
internal static class OrcaTmuxShim
{
    private const string Subcommand = "agent-teams-tmux";

    private static int Main(string[] args)
    {
        try
        {
            // Why: ORCA_AGENT_TEAMS_SHIM_BIN defaults to orca.cmd per the win32 CLI fallback name.
            string shimBin = Environment.GetEnvironmentVariable("ORCA_AGENT_TEAMS_SHIM_BIN");
            if (String.IsNullOrEmpty(shimBin))
            {
                shimBin = "orca.cmd";
            }

            using (Process child = Process.Start(BuildStartInfo(shimBin, args)))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start the Orca tmux shim: {0}", error.Message);
            return 1;
        }
    }

    private static ProcessStartInfo BuildStartInfo(string shimBin, string[] args)
    {
        // Why: CreateProcess cannot execute a batch file, and the shim bin is orca.cmd or
        // orca-dev.cmd on the dev path, so batch targets have to go through cmd.exe. cmd parses
        // the string itself, so it needs QuoteForCmd rather than the CRT quoting a direct .exe
        // wants; %VAR% still expands there, which is why the packaged path resolves to orca.exe.
        if (IsBatchFile(shimBin))
        {
            string[] batchArgs = Prepend(Subcommand, args);
            RejectLineBreaks(batchArgs);
            return new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/s /c \"" + WindowsCommandLine.Join(shimBin, batchArgs, true) + "\"",
                UseShellExecute = false
            };
        }

        return new ProcessStartInfo
        {
            FileName = shimBin,
            // Why: Arguments must exclude the program itself; FileName already supplies it.
            // Including it shifts argv and the CLI stops recognizing agent-teams-tmux.
            Arguments = WindowsCommandLine.Join(Subcommand, args),
            UseShellExecute = false
        };
    }

    // Why: cmd ends the command at a line break and no quoting suppresses that, so a multi-line
    // send-keys payload would run its tail as a separate command. Direct .exe targets are unaffected.
    private static void RejectLineBreaks(string[] args)
    {
        foreach (string arg in args)
        {
            if (arg.IndexOf('\r') >= 0 || arg.IndexOf('\n') >= 0)
            {
                throw new ArgumentException(
                    "arguments containing line breaks cannot be forwarded through a batch shim bin");
            }
        }
    }

    private static bool IsBatchFile(string path)
    {
        return path.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
    }

    private static string[] Prepend(string first, string[] rest)
    {
        string[] combined = new string[rest.Length + 1];
        combined[0] = first;
        for (int index = 0; index < rest.Length; index += 1)
        {
            combined[index + 1] = rest[index];
        }
        return combined;
    }
}
