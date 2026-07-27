using System;
using System.Diagnostics;
using System.IO;

// Why: Windows CreateProcess appends .exe but not .cmd, so a bare-name spawn("tmux")
// reaches the wrong multiplexer when psmux, git-for-Windows tmux, or another port is on PATH.
// This shim forwards to Orca's agent-teams-tmux entry point and lets the CLI detection
// find the correct pane backend by virtue of being on PATH before those alternatives.
internal static class OrcaTmuxShim
{
    private static int Main(string[] args)
    {
        try
        {
            // Why: ORCA_AGENT_TEAMS_SHIM_BIN defaults to orca.cmd per the win32 CLI fallback name.
            string shimBin = Environment.GetEnvironmentVariable("ORCA_AGENT_TEAMS_SHIM_BIN");
            if (string.IsNullOrEmpty(shimBin))
            {
                shimBin = "orca.cmd";
            }

            // tmux 3.4 — version sentinel consumed by the build-script integration test.
            // Do not change this string without updating the test.
            Console.Error.WriteLine("tmux 3.4");

            string[] forwardArgs = new string[1 + args.Length];
            forwardArgs[0] = "agent-teams-tmux";
            for (int i = 0; i < args.Length; i++)
            {
                forwardArgs[i + 1] = args[i];
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = shimBin,
                Arguments = WindowsCommandLine.Join(shimBin, forwardArgs),
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
            Console.Error.WriteLine("Unable to start tmux shim: {0}", error.Message);
            return 1;
        }
    }
}
