using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class BrokerAccessProbe
{
    private const uint OpenExisting = 3;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateNamedPipe(
        string name, uint openMode, uint pipeMode, uint maxInstances,
        uint outBufferSize, uint inBufferSize, uint defaultTimeout, IntPtr securityAttributes);

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "identity")
        {
            Console.WriteLine("IDENTITY_ACCOUNT=" + WindowsIdentity.GetCurrent().Name);
            return 0;
        }
        if (args.Length != 2) return 64;
        uint desiredAccess;
        SafeFileHandle opened;
        if (args[1] == "create-instance")
            opened = CreateNamedPipe(args[0], 3, 0, 2, 4096, 4096, 0, IntPtr.Zero);
        else if (UInt32.TryParse(args[1], out desiredAccess))
            opened = CreateFile(
                args[0], desiredAccess, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        else
            return 64;
        using (SafeFileHandle handle = opened)
        {
            if (!handle.IsInvalid) return 0;
            int error = Marshal.GetLastWin32Error();
            Console.WriteLine("WIN32_ERROR=" + error);
            return error == 5 ? 5 : 1;
        }
    }
}
