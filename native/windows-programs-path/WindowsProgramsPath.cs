using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsProgramsPath
{
    private static readonly Guid ProgramsFolderId = new Guid(
        "A77F5D77-2E2B-44C3-A6A2-ABA601054A51"
    );

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHGetKnownFolderPath(
        ref Guid folderId,
        uint flags,
        IntPtr token,
        out IntPtr path
    );

    private static int Main()
    {
        IntPtr pathPointer = IntPtr.Zero;
        try
        {
            Guid folderId = ProgramsFolderId;
            int result = SHGetKnownFolderPath(ref folderId, 0, IntPtr.Zero, out pathPointer);
            if (result < 0)
            {
                Marshal.ThrowExceptionForHR(result);
            }

            // Why: Node decodes bridge output as UTF-8, while legacy Windows
            // console code pages cannot represent every redirected folder name.
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.Out.WriteLine(Marshal.PtrToStringUni(pathPointer));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Unable to resolve FOLDERID_Programs: {0}", error.Message);
            return 1;
        }
        finally
        {
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pathPointer);
            }
        }
    }
}
