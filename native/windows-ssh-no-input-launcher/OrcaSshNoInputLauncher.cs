using System;
using System.IO;

internal static class OrcaSshNoInputLauncher
{
    private static int Main(string[] args)
    {
        try
        {
            int executableIndex = 0;
            int diagnosticTimeoutMilliseconds = 0;
            if (args.Length >= 2 && args[0] == "--diagnostic-timeout-ms")
            {
                if (!Int32.TryParse(args[1], out diagnosticTimeoutMilliseconds) ||
                    diagnosticTimeoutMilliseconds < 100 ||
                    diagnosticTimeoutMilliseconds > 60000)
                {
                    Console.Error.WriteLine("--diagnostic-timeout-ms requires 100 through 60000.");
                    return 2;
                }
                executableIndex = 2;
            }
            if (args.Length <= executableIndex)
            {
                Console.Error.WriteLine(
                    "Usage: orca-ssh-no-input.exe [--diagnostic-timeout-ms <milliseconds>] <ssh.exe> [arguments...]"
                );
                return 2;
            }
            string executablePath = Path.GetFullPath(args[executableIndex]);
            if (!File.Exists(executablePath))
            {
                Console.Error.WriteLine("Unable to locate the SSH executable at \"{0}\".", executablePath);
                return 2;
            }

            string[] childArgs = new string[args.Length - executableIndex - 1];
            Array.Copy(args, executableIndex + 1, childArgs, 0, childArgs.Length);
            return WindowsSshChildProcess.Run(
                executablePath,
                childArgs,
                diagnosticTimeoutMilliseconds
            );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to start the no-input SSH child: {0}", error.Message);
            return 1;
        }
    }
}
