using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class OrcaRuntimePipeBroker
{
    private const PipeAccessRights ClientRights =
        PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize;
    private const string ConfigVersion = "ORCA_RUNTIME_PIPE_BROKER_V2";
    private const int MaxDeadlineMs = 120000;

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        internal IntPtr Reserved1;
        internal IntPtr PebBaseAddress;
        internal IntPtr Reserved2A;
        internal IntPtr Reserved2B;
        internal IntPtr UniqueProcessId;
        internal IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle, int informationClass, ref ProcessBasicInformation information,
        int informationLength, out int returnLength);

    private enum SidNameUse
    {
        User = 1,
        Group,
        Domain,
        Alias,
        WellKnownGroup,
        DeletedAccount,
        Invalid,
        Unknown,
        Computer,
        Label,
        LogonSession
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupAccountName(
        string systemName, string accountName, byte[] sid, ref uint sidSize,
        StringBuilder referencedDomainName, ref uint domainNameSize, out SidNameUse sidUse);

    private sealed class CopyResult
    {
        internal Exception Failure;
        internal long Bytes;
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 0) return 64;
            string version = Console.In.ReadLine();
            string instanceId = Console.In.ReadLine();
            string serverPidText = Console.In.ReadLine();
            string runtimeId = Console.In.ReadLine();
            string authorizedSandboxAccount = Console.In.ReadLine();
            string deadlineText = Console.In.ReadLine();
            if (version != ConfigVersion) return 64;

            int serverPid;
            int deadlineMs;
            if (!Int32.TryParse(serverPidText, out serverPid) || serverPid <= 0 ||
                !Int32.TryParse(deadlineText, out deadlineMs) || deadlineMs <= 0 ||
                deadlineMs > MaxDeadlineMs) return 64;
            if (serverPid != GetParentProcessId()) return 5;

            string publicName = BuildPublicName(instanceId);
            string targetName = BuildPrivateName(serverPid, runtimeId);
            using (Process supervisor = Process.GetProcessById(serverPid))
            using (ManualResetEvent supervisorExited = new ManualResetEvent(false))
            {
                supervisor.EnableRaisingEvents = true;
                supervisor.Exited += delegate { supervisorExited.Set(); };
                if (supervisor.HasExited) return 1;
                PipeSecurity security = BuildSecurity(authorizedSandboxAccount);
                NamedPipeServerStream inbound = CreateInbound(publicName, security);
                Console.Out.WriteLine(@"READY \\.\pipe\" + publicName);
                Console.Out.Flush();
                try
                {
                    while (true)
                    {
                        Stopwatch deadline = Stopwatch.StartNew();
                        int accept = WaitForConnection(
                            inbound, supervisorExited, Remaining(deadline, deadlineMs));
                        if (accept != 0) return accept;
                        using (NamedPipeClientStream outbound = new NamedPipeClientStream(
                            ".", targetName, PipeDirection.InOut, PipeOptions.Asynchronous))
                        {
                            outbound.Connect(Remaining(deadline, deadlineMs));
                            int forwarded = ForwardDuplex(
                                inbound, outbound, supervisorExited,
                                Remaining(deadline, deadlineMs));
                            if (forwarded != 0) return forwarded;
                        }
                        inbound.Disconnect();
                    }
                }
                finally { inbound.Dispose(); }
            }
        }
        catch (UnauthorizedAccessException) { return 5; }
        catch (TimeoutException) { return 1460; }
        catch (Exception) { return 1; }
    }

    private static PipeSecurity BuildSecurity(string authorizedSandboxAccount)
    {
        SecurityIdentifier serverSid = WindowsIdentity.GetCurrent().User;
        SecurityIdentifier sandboxSid = ResolveLocalUserSid(authorizedSandboxAccount);
        Console.Error.WriteLine(
            "AUTHORIZED_ACCOUNT={0} AUTHORIZED_SID={1} RIGHTS=0x{2:X}",
            authorizedSandboxAccount, sandboxSid.Value, (int)ClientRights);
        Console.Error.Flush();
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(serverSid);
        security.AddAccessRule(new PipeAccessRule(
            sandboxSid, ClientRights, AccessControlType.Allow));
        return security;
    }

    private static SecurityIdentifier ResolveLocalUserSid(string account)
    {
        if (String.IsNullOrEmpty(account)) throw new ArgumentException("Missing sandbox account");
        string[] parts = account.Split(new char[] { '\\' }, 2);
        if (parts.Length != 2 ||
            !String.Equals(parts[0], Environment.MachineName, StringComparison.OrdinalIgnoreCase) ||
            String.IsNullOrEmpty(parts[1]))
            throw new ArgumentException("Sandbox authorization must name one local user");

        uint sidSize = 0;
        uint domainSize = 0;
        SidNameUse sidUse;
        LookupAccountName(
            Environment.MachineName, account, null, ref sidSize, null, ref domainSize, out sidUse);
        if (sidSize == 0) throw new ArgumentException("Sandbox account was not found");
        byte[] sid = new byte[sidSize];
        StringBuilder domain = new StringBuilder((int)domainSize);
        if (!LookupAccountName(
            Environment.MachineName, account, sid, ref sidSize, domain, ref domainSize, out sidUse))
            throw new InvalidOperationException("Unable to resolve sandbox account");
        if (sidUse != SidNameUse.User ||
            !String.Equals(
                domain.ToString(), Environment.MachineName, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Sandbox authorization must resolve to one local user");
        return new SecurityIdentifier(sid, 0);
    }

    private static int GetParentProcessId()
    {
        ProcessBasicInformation information = new ProcessBasicInformation();
        int returned;
        int status = NtQueryInformationProcess(
            Process.GetCurrentProcess().Handle, 0, ref information,
            Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned);
        if (status != 0) throw new InvalidOperationException("Unable to verify broker supervisor");
        return information.InheritedFromUniqueProcessId.ToInt32();
    }

    private static string BuildPublicName(string instanceId)
    {
        ValidateComponent(instanceId, 64);
        return "orca-broker-" + instanceId;
    }

    private static string BuildPrivateName(int serverPid, string runtimeId)
    {
        ValidateComponent(runtimeId, 128);
        string suffix = "";
        foreach (char value in runtimeId)
        {
            if (Char.IsLetterOrDigit(value) || value == '_' || value == '-') suffix += value;
            if (suffix.Length == 4) break;
        }
        if (suffix.Length == 0) suffix = "rt";
        return "orca-" + serverPid + "-" + suffix;
    }

    private static void ValidateComponent(string value, int maxLength)
    {
        if (String.IsNullOrEmpty(value) || value.Length > maxLength)
            throw new ArgumentException("Invalid broker instance component");
        foreach (char item in value)
            if (!Char.IsLetterOrDigit(item) && item != '_' && item != '-')
                throw new ArgumentException("Invalid broker instance component");
    }

    private static int WaitForConnection(
        NamedPipeServerStream pipe, WaitHandle supervisorExited, int timeoutMs)
    {
        IAsyncResult pending = pipe.BeginWaitForConnection(null, null);
        int result = WaitHandle.WaitAny(
            new WaitHandle[] { pending.AsyncWaitHandle, supervisorExited }, timeoutMs);
        if (result == WaitHandle.WaitTimeout) return 1460;
        if (result == 1) return 1;
        pipe.EndWaitForConnection(pending);
        return 0;
    }

    private static NamedPipeServerStream CreateInbound(string publicName, PipeSecurity security)
    {
        return new NamedPipeServerStream(
            publicName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 65536, 65536, security);
    }

    private static int Remaining(Stopwatch deadline, int deadlineMs)
    {
        long remaining = deadlineMs - deadline.ElapsedMilliseconds;
        if (remaining <= 0) throw new TimeoutException();
        return (int)remaining;
    }

    private static int ForwardDuplex(
        Stream inbound, Stream outbound, WaitHandle supervisorExited, int timeoutMs)
    {
        Stopwatch deadline = Stopwatch.StartNew();
        CopyResult request = new CopyResult();
        CopyResult response = new CopyResult();
        ManualResetEvent completed = new ManualResetEvent(false);
        Thread requestThread = new Thread(() => Copy(inbound, outbound, request, completed));
        Thread responseThread = new Thread(() => Copy(outbound, inbound, response, completed));
        requestThread.IsBackground = true;
        responseThread.IsBackground = true;
        requestThread.Start();
        responseThread.Start();

        int waitResult = WaitHandle.WaitAny(
            new WaitHandle[] { completed, supervisorExited }, timeoutMs);
        bool requestStopped = false;
        bool responseStopped = false;
        if (waitResult == 0)
        {
            requestStopped = JoinWithinDeadline(requestThread, deadline, timeoutMs);
            responseStopped = JoinWithinDeadline(responseThread, deadline, timeoutMs);
        }
        if (!requestStopped || !responseStopped)
        {
            inbound.Dispose();
            outbound.Dispose();
            requestStopped = requestStopped || JoinWithinDeadline(requestThread, deadline, timeoutMs);
            responseStopped = responseStopped || JoinWithinDeadline(responseThread, deadline, timeoutMs);
        }
        completed.Dispose();

        if (waitResult == WaitHandle.WaitTimeout ||
            ((!requestStopped || !responseStopped) && deadline.ElapsedMilliseconds >= timeoutMs))
            return 1460;
        if (waitResult == 1) return 1;
        if (!requestStopped || !responseStopped) return 1;
        if (request.Failure != null || response.Failure != null) return 1;
        if (request.Bytes == 0 || response.Bytes == 0) return 1;
        return 0;
    }

    private static bool JoinWithinDeadline(Thread thread, Stopwatch deadline, int timeoutMs)
    {
        long remaining = timeoutMs - deadline.ElapsedMilliseconds;
        return thread.Join(remaining > 0 ? (int)remaining : 0);
    }

    private static void Copy(Stream source, Stream destination, CopyResult result,
        EventWaitHandle completed)
    {
        try
        {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                int frameLength = count;
                for (int index = 0; index < count; index++)
                {
                    if (buffer[index] == (byte)'\n')
                    {
                        frameLength = index + 1;
                        break;
                    }
                }
                destination.Write(buffer, 0, frameLength);
                destination.Flush();
                result.Bytes += frameLength;
                if (frameLength != count || buffer[frameLength - 1] == (byte)'\n') return;
            }
        }
        catch (Exception ex)
        {
            if (!(ex is ObjectDisposedException)) result.Failure = ex;
        }
        finally { completed.Set(); }
    }
}
