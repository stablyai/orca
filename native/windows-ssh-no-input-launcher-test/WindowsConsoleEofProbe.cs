using System;
using System.Runtime.InteropServices;

internal static class WindowsConsoleEofProbe
{
    private const int StandardInputHandle = -10;
    private const uint FileTypeChar = 0x0002;
    private const uint EnableProcessedInput = 0x0001;
    private const uint EnableLineInput = 0x0002;

    private static int Main()
    {
        IntPtr input = GetStdHandle(StandardInputHandle);
        uint mode;
        if (input == IntPtr.Zero || input == new IntPtr(-1) || GetFileType(input) != FileTypeChar)
        {
            Console.Error.WriteLine("stdin is not a character-device handle");
            return 2;
        }
        if (!GetConsoleMode(input, out mode))
        {
            Console.Error.WriteLine("stdin is not a console input handle");
            return 3;
        }
        if (!SetConsoleMode(input, mode | EnableProcessedInput | EnableLineInput))
        {
            Console.Error.WriteLine("unable to select cooked console input");
            return 4;
        }

        byte[] buffer = new byte[1];
        uint bytesRead;
        if (!ReadFile(input, buffer, (uint)buffer.Length, out bytesRead, IntPtr.Zero))
        {
            Console.Error.WriteLine("console ReadFile failed: {0}", Marshal.GetLastWin32Error());
            return 5;
        }
        Console.Out.Write("ORCA-PRIVATE-CONSOLE-EOF bytes={0}", bytesRead);
        return bytesRead == 0 ? 0 : 6;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(IntPtr file);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetConsoleMode(IntPtr console, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleMode(IntPtr console, uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        IntPtr file,
        [Out] byte[] buffer,
        uint bytesToRead,
        out uint bytesRead,
        IntPtr overlapped
    );
}
