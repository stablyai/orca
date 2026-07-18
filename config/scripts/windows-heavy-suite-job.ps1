$ErrorActionPreference = 'Stop'

$payloadBytes = [Convert]::FromBase64String($env:ORCA_WINDOWS_HEAVY_SUITE_STEP)
$payloadJson = [Text.Encoding]::UTF8.GetString($payloadBytes)
Remove-Item Env:ORCA_WINDOWS_HEAVY_SUITE_STEP -ErrorAction SilentlyContinue
$step = $payloadJson | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OrcaHeavySuiteJob
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_FAILED = 0xffffffff;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000d);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        int informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        int informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inheritHandle,
        uint options);

    private static void AssertWin32(bool condition, string operation)
    {
        if (!condition)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }
        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append(character);
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string BuildCommandLine(string command, string[] arguments)
    {
        if (command.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
            command.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
        {
            throw new NotSupportedException("Batch commands are not accepted by the Windows Job Object runner.");
        }
        var commandLine = new StringBuilder(QuoteArgument(command));
        foreach (var argument in arguments ?? new string[0])
        {
            commandLine.Append(' ').Append(QuoteArgument(argument));
        }
        return commandLine.ToString();
    }

    private static IntPtr DuplicateStandardHandle(int standardHandle)
    {
        var source = GetStdHandle(standardHandle);
        if (source == IntPtr.Zero || source == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetStdHandle");
        }
        IntPtr duplicate;
        var currentProcess = GetCurrentProcess();
        AssertWin32(
            DuplicateHandle(
                currentProcess,
                source,
                currentProcess,
                out duplicate,
                0,
                true,
                DUPLICATE_SAME_ACCESS),
            "DuplicateHandle");
        return duplicate;
    }

    public static int Run(string command, string[] arguments)
    {
        if (String.IsNullOrWhiteSpace(command))
        {
            throw new ArgumentException("A command is required.", "command");
        }

        var job = IntPtr.Zero;
        var processInfo = new PROCESS_INFORMATION();
        var childStdIn = IntPtr.Zero;
        var childStdOut = IntPtr.Zero;
        var childStdErr = IntPtr.Zero;
        var attributeList = IntPtr.Zero;
        var jobListValue = IntPtr.Zero;
        var attributeListInitialized = false;
        var processCreated = false;
        var completed = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            AssertWin32(job != IntPtr.Zero, "CreateJobObject");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            AssertWin32(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))),
                "SetInformationJobObject");

            var attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "InitializeProcThreadAttributeList(size)");
            }
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            AssertWin32(
                InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize),
                "InitializeProcThreadAttributeList");
            attributeListInitialized = true;
            jobListValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobListValue, job);
            AssertWin32(
                UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST,
                    jobListValue,
                    new IntPtr(IntPtr.Size),
                    IntPtr.Zero,
                    IntPtr.Zero),
                "UpdateProcThreadAttribute");

            var startupInfo = new STARTUPINFOEX();
            startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startupInfo.lpAttributeList = attributeList;
            childStdIn = DuplicateStandardHandle(STD_INPUT_HANDLE);
            childStdOut = DuplicateStandardHandle(STD_OUTPUT_HANDLE);
            childStdErr = DuplicateStandardHandle(STD_ERROR_HANDLE);
            startupInfo.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startupInfo.StartupInfo.hStdInput = childStdIn;
            startupInfo.StartupInfo.hStdOutput = childStdOut;
            startupInfo.StartupInfo.hStdError = childStdErr;
            var commandLine = new StringBuilder(BuildCommandLine(command, arguments));
            AssertWin32(
                CreateProcessW(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero,
                    null,
                    ref startupInfo,
                    out processInfo),
                "CreateProcessW");
            processCreated = true;
            CloseHandle(childStdIn);
            CloseHandle(childStdOut);
            CloseHandle(childStdErr);
            childStdIn = childStdOut = childStdErr = IntPtr.Zero;
            AssertWin32(ResumeThread(processInfo.hThread) != WAIT_FAILED, "ResumeThread");
            CloseHandle(processInfo.hThread);
            processInfo.hThread = IntPtr.Zero;

            AssertWin32(WaitForSingleObject(processInfo.hProcess, INFINITE) != WAIT_FAILED, "WaitForProcess");
            uint exitCode;
            AssertWin32(GetExitCodeProcess(processInfo.hProcess, out exitCode), "GetExitCodeProcess");
            CloseHandle(processInfo.hProcess);
            processInfo.hProcess = IntPtr.Zero;
            while (true)
            {
                var accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
                AssertWin32(
                    QueryInformationJobObject(
                        job,
                        1,
                        ref accounting,
                        Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                        IntPtr.Zero),
                    "QueryInformationJobObject");
                if (accounting.ActiveProcesses == 0)
                {
                    break;
                }
                Thread.Sleep(25);
            }
            completed = true;
            return unchecked((int)exitCode);
        }
        finally
        {
            if (processCreated && !completed && processInfo.hProcess != IntPtr.Zero)
            {
                TerminateProcess(processInfo.hProcess, 1);
            }
            if (processInfo.hThread != IntPtr.Zero)
            {
                CloseHandle(processInfo.hThread);
            }
            if (processInfo.hProcess != IntPtr.Zero)
            {
                CloseHandle(processInfo.hProcess);
            }
            if (childStdIn != IntPtr.Zero)
            {
                CloseHandle(childStdIn);
            }
            if (childStdOut != IntPtr.Zero)
            {
                CloseHandle(childStdOut);
            }
            if (childStdErr != IntPtr.Zero)
            {
                CloseHandle(childStdErr);
            }
            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
            }
            if (attributeList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(attributeList);
            }
            if (jobListValue != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobListValue);
            }
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
            }
        }
    }
}
'@

$arguments = @($step.args | ForEach-Object { [string]$_ })
$exitCode = [OrcaHeavySuiteJob]::Run([string]$step.command, [string[]]$arguments)
exit $exitCode
