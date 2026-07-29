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
            RejectUnrepresentableForCmd(batchArgs);
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

    // Why: two things survive any quoting cmd.exe accepts, so the only safe answer is to refuse.
    // A line break ends the command, running the tail separately. A %NAME% reference is expanded
    // AFTER quoting, so a variable whose *value* holds a quote or operator escapes the quoted region
    // entirely — measured: a value of INJECTED"&whoami ran whoami. Direct .exe targets are unaffected;
    // tmux's own %1 / %99 pane ids are not variable references and pass through untouched.
    private static void RejectUnrepresentableForCmd(string[] args)
    {
        foreach (string arg in args)
        {
            if (arg.IndexOf('\r') >= 0 || arg.IndexOf('\n') >= 0)
            {
                throw new ArgumentException(
                    "arguments containing line breaks cannot be forwarded through a batch shim bin");
            }
            if (ContainsEnvironmentReference(arg))
            {
                throw new ArgumentException(
                    "arguments containing a %NAME% environment reference cannot be forwarded through a batch shim bin");
            }
        }
    }

    // Matches %NAME% with a shell-variable-shaped NAME regardless of whether it is currently defined,
    // so the verdict does not depend on the environment the child happens to inherit.
    private static bool ContainsEnvironmentReference(string value)
    {
        for (int index = 0; index < value.Length; index += 1)
        {
            if (value[index] != '%')
            {
                continue;
            }

            int scan = index + 1;
            if (scan >= value.Length)
            {
                break;
            }
            if (!Char.IsLetter(value[scan]) && value[scan] != '_')
            {
                continue;
            }

            scan += 1;
            while (scan < value.Length && (Char.IsLetterOrDigit(value[scan]) || value[scan] == '_'))
            {
                scan += 1;
            }
            if (scan < value.Length && value[scan] == '%')
            {
                return true;
            }
        }
        return false;
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
