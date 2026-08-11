using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class DuplicatePathProcessLauncher
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main(string[] args)
    {
        List<string> entries = new List<string>();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (!String.Equals((string)entry.Key, "PATH", StringComparison.OrdinalIgnoreCase))
            {
                entries.Add((string)entry.Key + "=" + (string)entry.Value);
            }
        }
        entries.Add("PATH=C:\\live");
        entries.Add("Path=C:\\shadowed");
        entries.Add("ORCA_TEST_OUTPUT=" + args[1]);

        IntPtr environment = Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
        StartupInfo startupInfo = new StartupInfo();
        startupInfo.cb = Marshal.SizeOf(startupInfo);
        ProcessInformation processInformation;
        try
        {
            bool started = CreateProcess(
                args[0],
                new StringBuilder("\"" + args[0] + "\""),
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                0x00000400,
                environment,
                null,
                ref startupInfo,
                out processInformation
            );
            if (!started)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(environment);
        }

        try
        {
            WaitForSingleObject(processInformation.hProcess, 0xffffffff);
            uint exitCode;
            if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return (int)exitCode;
        }
        finally
        {
            CloseHandle(processInformation.hThread);
            CloseHandle(processInformation.hProcess);
        }
    }
}
