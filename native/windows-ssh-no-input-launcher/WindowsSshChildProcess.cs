using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsSshChildProcess
{
    private const uint CreateSuspended = 0x00000004;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitFailed = 0xffffffff;
    private const uint WaitTimeout = 0x00000102;
    private const uint OutputLimitPollMilliseconds = 50;
    private const uint JobSettlementTimeoutMilliseconds = 5000;

    internal static int Run(
        string executablePath,
        string[] args,
        int diagnosticTimeoutMilliseconds
    )
    {
        Stream launcherStdout = Console.OpenStandardOutput();
        Stream launcherStderr = Console.OpenStandardError();
        using (WindowsPrivateConsoleInput console = WindowsPrivateConsoleInput.Create())
        using (WindowsBoundedOutputFiles outputs = WindowsBoundedOutputFiles.Create(
            console.InputHandle,
            launcherStdout,
            launcherStderr
        ))
        {
            IntPtr job = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr inheritedHandles = IntPtr.Zero;
            ProcessInformation process = new ProcessInformation();
            bool processStarted = false;
            bool assignedToJob = false;
            try
            {
                job = CreateKillOnCloseJob();
                StartupInfoEx startup = CreateStartupInfo(outputs, out attributeList, out inheritedHandles);
                StringBuilder commandLine = WindowsCommandLine.Build(executablePath, args);
                // Why: the SSH child must share the hidden private console for CONIN$ to remain a
                // real console handle; CREATE_NO_WINDOW would detach it from that console.
                uint flags = CreateSuspended | ExtendedStartupInfoPresent;
                if (!CreateProcess(
                    executablePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    flags,
                    IntPtr.Zero,
                    null,
                    ref startup,
                    out process
                ))
                {
                    throw LastWin32("CreateProcessW failed.");
                }
                processStarted = true;
                outputs.CloseChildEndsInParent();
                if (!AssignProcessToJobObject(job, process.Process))
                {
                    throw LastWin32("AssignProcessToJobObject failed.");
                }
                assignedToJob = true;
                if (ResumeThread(process.Thread) == UInt32.MaxValue)
                {
                    throw LastWin32("ResumeThread failed.");
                }

                bool exited = WaitForChildWithinOutputLimits(
                    process.Process,
                    outputs,
                    diagnosticTimeoutMilliseconds
                );
                if (!exited)
                {
                    // Why: the runner must recover verbose bytes without relying on an external
                    // kill that also destroys the delete-on-close diagnostic captures.
                    TerminateAndSettleJob(ref job);
                    outputs.ReplayOutputs();
                    throw new TimeoutException(
                        "SSH child reached the " + diagnosticTimeoutMilliseconds +
                        " ms diagnostic timeout."
                    );
                }
                uint exitCode;
                if (!GetExitCodeProcess(process.Process, out exitCode))
                {
                    throw LastWin32("GetExitCodeProcess failed.");
                }
                // Why: descendants must release inherited writers before replay can trust the bytes.
                TerminateAndSettleJob(ref job);
                outputs.ReplayOutputs();
                return unchecked((int)exitCode);
            }
            finally
            {
                outputs.CloseChildEndsInParent();
                if (process.Thread != IntPtr.Zero)
                {
                    CloseHandle(process.Thread);
                }
                if (process.Process != IntPtr.Zero)
                {
                    if (processStarted && !assignedToJob)
                    {
                        // A suspended child outside the job would otherwise survive setup failure.
                        TerminateProcess(process.Process, 1);
                    }
                    CloseHandle(process.Process);
                }
                // Why: managed failures must not outlive their capture files or SSH child job.
                TerminateAndSettleJob(ref job);
                if (attributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (inheritedHandles != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(inheritedHandles);
                }
            }
        }
    }

    private static StartupInfoEx CreateStartupInfo(
        WindowsBoundedOutputFiles outputs,
        out IntPtr attributeList,
        out IntPtr inheritedHandles
    )
    {
        IntPtr attributeBytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
        if (attributeBytes == IntPtr.Zero)
        {
            throw LastWin32("Unable to size the process attribute list.");
        }

        attributeList = Marshal.AllocHGlobal(attributeBytes);
        inheritedHandles = IntPtr.Zero;
        try
        {
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes))
            {
                throw LastWin32("InitializeProcThreadAttributeList failed.");
            }

            inheritedHandles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(inheritedHandles, 0, outputs.StdinRead);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size, outputs.StdoutWrite);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size * 2, outputs.StderrWrite);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeHandleList),
                inheritedHandles,
                new IntPtr(IntPtr.Size * 3),
                IntPtr.Zero,
                IntPtr.Zero
            ))
            {
                throw LastWin32("UpdateProcThreadAttribute failed.");
            }

            StartupInfoEx startup = new StartupInfoEx();
            startup.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.Flags = StartfUseStdHandles;
            startup.StartupInfo.StandardInput = outputs.StdinRead;
            startup.StartupInfo.StandardOutput = outputs.StdoutWrite;
            startup.StartupInfo.StandardError = outputs.StderrWrite;
            startup.AttributeList = attributeList;
            return startup;
        }
        catch
        {
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
                attributeList = IntPtr.Zero;
            }
            if (inheritedHandles != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(inheritedHandles);
                inheritedHandles = IntPtr.Zero;
            }
            throw;
        }
    }

    private static bool WaitForChildWithinOutputLimits(
        IntPtr process,
        WindowsBoundedOutputFiles outputs,
        int diagnosticTimeoutMilliseconds
    )
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (true)
        {
            uint waitMilliseconds = OutputLimitPollMilliseconds;
            if (diagnosticTimeoutMilliseconds > 0)
            {
                long remaining = diagnosticTimeoutMilliseconds - elapsed.ElapsedMilliseconds;
                if (remaining <= 0)
                {
                    return false;
                }
                if (remaining < waitMilliseconds)
                {
                    waitMilliseconds = (uint)remaining;
                }
            }
            uint waitResult = WaitForSingleObject(process, waitMilliseconds);
            if (waitResult == WaitObject0)
            {
                outputs.EnsureWithinLimits();
                return true;
            }
            if (waitResult == WaitFailed)
            {
                throw LastWin32("WaitForSingleObject failed.");
            }
            if (waitResult != WaitTimeout)
            {
                throw new Win32Exception("Unexpected child-process wait result.");
            }
            outputs.EnsureWithinLimits();
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw LastWin32("CreateJobObject failed.");
        }
        JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                buffer,
                (uint)size
            ))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error, "SetInformationJobObject failed.");
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Win32Exception LastWin32(string message)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    private static void CloseOwnedHandle(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }

    private static void TerminateAndSettleJob(ref IntPtr job)
    {
        if (job == IntPtr.Zero)
        {
            return;
        }
        try
        {
            if (!TerminateJobObject(job, 1))
            {
                throw LastWin32("TerminateJobObject failed.");
            }
            uint waitResult = WaitForSingleObject(job, JobSettlementTimeoutMilliseconds);
            if (waitResult == WaitTimeout)
            {
                throw new TimeoutException("SSH child job did not settle within 5 seconds.");
            }
            if (waitResult == WaitFailed)
            {
                throw LastWin32("Waiting for the SSH child job failed.");
            }
            if (waitResult != WaitObject0)
            {
                throw new Win32Exception("Unexpected SSH child job wait result.");
            }
        }
        finally
        {
            CloseOwnedHandle(ref job);
        }
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
    private struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateProcessW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
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
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateJobObjectW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

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
