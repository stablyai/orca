using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class OrcaGrokHookLauncher
{
    private const int ChildExitTimeoutMilliseconds = 4000;

    [STAThread]
    private static int Main()
    {
        try
        {
            string launcherDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string scriptPath = Path.Combine(launcherDirectory ?? ".", "grok-hook.cmd");
            if (!File.Exists(scriptPath))
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                scriptPath = Path.Combine(home, ".orca", "agent-hooks", "grok-hook.cmd");
            }
            if (!File.Exists(scriptPath))
            {
                return 0;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            startInfo.Arguments = "/d /c \"" + scriptPath + "\"";
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.RedirectStandardInput = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            using (Process child = Process.Start(startInfo))
            {
                if (child == null)
                {
                    return 0;
                }

                Thread stdinThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream input = Console.OpenStandardInput())
                        {
                            input.CopyTo(child.StandardInput.BaseStream);
                        }
                        child.StandardInput.Close();
                    }
                    catch
                    {
                    }
                });
                stdinThread.IsBackground = true;
                stdinThread.Start();

                Drain(child.StandardOutput.BaseStream);
                Drain(child.StandardError.BaseStream);
                if (!child.WaitForExit(ChildExitTimeoutMilliseconds))
                {
                    try
                    {
                        child.Kill();
                    }
                    catch
                    {
                    }
                }
            }
        }
        catch
        {
        }

        return 0;
    }

    private static void Drain(Stream stream)
    {
        Thread thread = new Thread(() =>
        {
            try
            {
                byte[] buffer = new byte[4096];
                while (stream.Read(buffer, 0, buffer.Length) > 0)
                {
                }
            }
            catch
            {
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
