using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class CrossAccountPipeClient
{
    private const PipeAccessRights ClientRights =
        PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize;
    private const uint OpenExisting = 3;
    private const uint TokenQuery = 0x0008;
    private const int TokenRestrictedSids = 11;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(
        IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr tokenHandle, int tokenClass, IntPtr tokenInformation,
        int tokenInformationLength, out int returnLength);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "identity")
            {
                PrintIdentity("SERVER");
                return 0;
            }
            if (args.Length != 1) return 64;
            string[] handoff = File.ReadAllLines(args[0]);
            if (handoff.Length != 5 || handoff[0] != "ORCA_CROSS_ACCOUNT_TEST_V1") return 64;
            string endpoint = handoff[1];
            string capability = handoff[2];
            string authorizedAccount = handoff[3];
            long expiresAt;
            if (!Int64.TryParse(handoff[4], out expiresAt) ||
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > expiresAt) return 1460;

            WindowsIdentity identity = PrintIdentity("CLIENT");
            Console.WriteLine("AUTHORIZED_ACCOUNT=" + authorizedAccount);
            if (!String.Equals(
                identity.Name, authorizedAccount, StringComparison.OrdinalIgnoreCase)) return 5;

            using (SafePipeHandle handle = OpenMinimalClient(endpoint, 5000))
            using (NamedPipeClientStream client = new NamedPipeClientStream(
                PipeDirection.InOut, false, true, handle))
            using (StreamReader reader = new StreamReader(client, Encoding.UTF8, false, 1024, true))
            using (StreamWriter writer = new StreamWriter(
                client, new UTF8Encoding(false), 1024, true))
            {
                writer.AutoFlush = true;
                writer.WriteLine(
                    "{\"id\":\"cross-account\",\"authToken\":\"" + capability +
                    "\",\"method\":\"diagnostics.ping\"}");
                string response = reader.ReadLine();
                if (response == null ||
                    response.IndexOf("\"ok\":true", StringComparison.Ordinal) < 0) return 1;
            }
            Console.WriteLine("CROSS_ACCOUNT_RPC=PASS RIGHTS=0x" +
                ((int)ClientRights).ToString("X"));
            return 0;
        }
        catch (UnauthorizedAccessException) { return 5; }
        catch (TimeoutException) { return 1460; }
        catch (Exception ex)
        {
            Console.Error.WriteLine("CLIENT_ERROR=" + ex.GetType().Name);
            return 1;
        }
    }

    private static WindowsIdentity PrintIdentity(string role)
    {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        Console.WriteLine(role + "_ACCOUNT=" + identity.Name);
        Console.WriteLine(role + "_SID=" + identity.User.Value);
        foreach (string sid in GetRestrictedSids())
            Console.WriteLine(role + "_RESTRICTED_SID=" + sid);
        return identity;
    }

    private static SafePipeHandle OpenMinimalClient(string endpoint, int timeoutMs)
    {
        if (!endpoint.StartsWith(@"\\.\pipe\orca-broker-", StringComparison.Ordinal))
            throw new ArgumentException("Unexpected test endpoint");
        Stopwatch timer = Stopwatch.StartNew();
        while (true)
        {
            SafePipeHandle handle = CreateFile(
                endpoint, (uint)ClientRights, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (!handle.IsInvalid) return handle;
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (error == 5) throw new UnauthorizedAccessException();
            if (timer.ElapsedMilliseconds >= timeoutMs) throw new TimeoutException();
            System.Threading.Thread.Sleep(25);
        }
    }

    private static string[] GetRestrictedSids()
    {
        IntPtr token;
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenQuery, out token))
            throw new InvalidOperationException("OpenProcessToken failed");
        try
        {
            int length;
            GetTokenInformation(token, TokenRestrictedSids, IntPtr.Zero, 0, out length);
            if (length == 0) return new string[0];
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(
                    token, TokenRestrictedSids, buffer, length, out length))
                    throw new InvalidOperationException("GetTokenInformation failed");
                int count = Marshal.ReadInt32(buffer);
                string[] result = new string[count];
                int entrySize = IntPtr.Size * 2;
                int offset = IntPtr.Size;
                for (int index = 0; index < count; index++)
                {
                    IntPtr sidPointer = Marshal.ReadIntPtr(
                        buffer, offset + index * entrySize);
                    result[index] = new SecurityIdentifier(sidPointer).Value;
                }
                return result;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }
}
