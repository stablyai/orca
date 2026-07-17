using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsLauncherHandleProbe
{
    private const uint CreateNoWindow = 0x08000000;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "probe")
            {
                return ProbeHandle(args[1]);
            }
            if (args.Length != 1)
            {
                Console.Error.WriteLine("Usage: handle-probe.exe <launcher.exe>");
                return 2;
            }
            return LaunchWithUnrelatedInheritableHandle(Path.GetFullPath(args[0]));
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Windows launcher handle probe failed: {0}", error.Message);
            return 1;
        }
    }

    private static int ProbeHandle(string rawHandle)
    {
        long value = Int64.Parse(rawHandle, CultureInfo.InvariantCulture);
        // A reused numeric handle in this process cannot signal the parent's event, so the
        // parent-side observation distinguishes real inheritance without depending on CLR handles.
        SetEvent(new IntPtr(value));
        return 0;
    }

    private static int LaunchWithUnrelatedInheritableHandle(string launcherPath)
    {
        SecurityAttributes security = new SecurityAttributes();
        security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
        security.InheritHandle = true;
        IntPtr unrelatedHandle = CreateEvent(ref security, false, false, null);
        if (unrelatedHandle == IntPtr.Zero)
        {
            throw LastWin32("CreateEventW failed.");
        }

        ProcessInformation process = new ProcessInformation();
        try
        {
            string probePath = typeof(WindowsLauncherHandleProbe).Assembly.Location;
            string[] launcherArgs = new string[] {
                probePath,
                "probe",
                unrelatedHandle.ToInt64().ToString(CultureInfo.InvariantCulture)
            };
            StringBuilder commandLine = BuildCommandLine(launcherPath, launcherArgs);
            StartupInfo startup = new StartupInfo();
            startup.Size = Marshal.SizeOf(typeof(StartupInfo));
            if (!CreateProcess(
                launcherPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateNoWindow,
                IntPtr.Zero,
                null,
                ref startup,
                out process
            ))
            {
                throw LastWin32("CreateProcessW failed for the launcher.");
            }

            uint wait = WaitForSingleObject(process.Process, 10000);
            if (wait == WaitTimeout)
            {
                TerminateProcess(process.Process, 74);
                throw new TimeoutException("Handle probe launcher did not settle within 10 seconds.");
            }
            if (wait != WaitObject0)
            {
                throw LastWin32("Handle probe launcher wait failed.");
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.Process, out exitCode))
            {
                throw LastWin32("GetExitCodeProcess failed for the launcher.");
            }
            if (exitCode != 0)
            {
                return unchecked((int)exitCode);
            }
            uint unrelatedWait = WaitForSingleObject(unrelatedHandle, 0);
            if (unrelatedWait == WaitObject0)
            {
                Console.Error.WriteLine("Unrelated parent event was inherited by the launcher child.");
                return 73;
            }
            if (unrelatedWait != WaitTimeout)
            {
                throw LastWin32("Unable to inspect the unrelated parent event.");
            }
            Console.WriteLine("ORCA-NO-INHERITED-HANDLE-LEAK");
            return 0;
        }
        finally
        {
            if (process.Thread != IntPtr.Zero)
            {
                CloseHandle(process.Thread);
            }
            if (process.Process != IntPtr.Zero)
            {
                CloseHandle(process.Process);
            }
            CloseHandle(unrelatedHandle);
        }
    }

    private static StringBuilder BuildCommandLine(string executablePath, string[] args)
    {
        StringBuilder commandLine = new StringBuilder(Quote(executablePath));
        foreach (string arg in args)
        {
            commandLine.Append(' ');
            commandLine.Append(Quote(arg));
        }
        return commandLine;
    }

    private static string Quote(string value)
    {
        StringBuilder quoted = new StringBuilder("\"");
        int backslashCount = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount += 1;
            }
            else
            {
                quoted.Append('\\', character == '"' ? backslashCount * 2 + 1 : backslashCount);
                quoted.Append(character);
                backslashCount = 0;
            }
        }
        quoted.Append('\\', backslashCount * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static Win32Exception LastWin32(string message)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal int Size;
        internal string Reserved;
        internal string Desktop;
        internal string Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal short ShowWindow;
        internal short Reserved2;
        internal IntPtr Reserved2Pointer;
        internal IntPtr StandardInput;
        internal IntPtr StandardOutput;
        internal IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateEvent(
        ref SecurityAttributes eventAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool manualReset,
        [MarshalAs(UnmanagedType.Bool)] bool initialState,
        string name
    );

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetEvent(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
