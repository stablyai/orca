using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

internal sealed class WindowsPrivateConsoleInput : IDisposable
{
    private const uint EnableProcessedInput = 0x0001;
    private const uint EnableLineInput = 0x0002;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint HandleFlagInherit = 0x00000001;
    private const short KeyEvent = 0x0001;
    private const ushort VirtualKeyZ = 0x5a;
    private const ushort VirtualKeyReturn = 0x0d;
    private const uint MapVirtualKeyToScanCode = 0;
    private const uint LeftCtrlPressed = 0x0008;
    private const int SwHide = 0;
    private const int ErrorInvalidHandle = 6;

    private IntPtr inputHandle;
    private bool ownsConsole;

    private WindowsPrivateConsoleInput()
    {
    }

    internal IntPtr InputHandle { get { return inputHandle; } }

    internal static WindowsPrivateConsoleInput Create()
    {
        WindowsPrivateConsoleInput console = new WindowsPrivateConsoleInput();
        try
        {
            console.DetachFromInheritedConsole();
            if (!AllocConsole())
            {
                throw LastWin32("AllocConsole failed.");
            }
            console.ownsConsole = true;
            HideConsoleWindow();

            console.inputHandle = CreateFile(
                "CONIN$",
                GenericRead | GenericWrite,
                FileShareRead | FileShareWrite,
                IntPtr.Zero,
                OpenExisting,
                0,
                IntPtr.Zero
            );
            if (console.inputHandle == new IntPtr(-1))
            {
                console.inputHandle = IntPtr.Zero;
                throw LastWin32("Unable to open the private console input buffer.");
            }
            if (!SetConsoleMode(console.inputHandle, EnableProcessedInput | EnableLineInput))
            {
                throw LastWin32("SetConsoleMode failed for private console input.");
            }
            if (!SetHandleInformation(
                console.inputHandle,
                HandleFlagInherit,
                HandleFlagInherit
            ))
            {
                throw LastWin32("Unable to make private console input inheritable.");
            }
            if (!FlushConsoleInputBuffer(console.inputHandle))
            {
                throw LastWin32("FlushConsoleInputBuffer failed.");
            }
            console.QueueEndOfInput();
            return console;
        }
        catch
        {
            console.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (inputHandle != IntPtr.Zero)
        {
            CloseHandle(inputHandle);
            inputHandle = IntPtr.Zero;
        }
        if (ownsConsole)
        {
            FreeConsole();
            ownsConsole = false;
        }
    }

    private void QueueEndOfInput()
    {
        // Why: Win32 console EOF is Ctrl+Z followed by Enter in cooked input mode; queue it before
        // child creation so the SSH input worker cannot race launcher startup.
        InputRecord[] records = new InputRecord[]
        {
            CreateKeyRecord(true, VirtualKeyZ, '\u001a', LeftCtrlPressed),
            CreateKeyRecord(false, VirtualKeyZ, '\u001a', LeftCtrlPressed),
            CreateKeyRecord(true, VirtualKeyReturn, '\r', 0),
            CreateKeyRecord(false, VirtualKeyReturn, '\r', 0)
        };
        uint written;
        if (!WriteConsoleInput(inputHandle, records, (uint)records.Length, out written))
        {
            throw LastWin32("WriteConsoleInputW failed.");
        }
        if (written != (uint)records.Length)
        {
            throw new Win32Exception("WriteConsoleInputW queued an incomplete EOF sequence.");
        }
    }

    private void DetachFromInheritedConsole()
    {
        if (!FreeConsole())
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorInvalidHandle)
            {
                throw new Win32Exception(error, "FreeConsole failed.");
            }
        }
    }

    private static void HideConsoleWindow()
    {
        IntPtr window = GetConsoleWindow();
        if (window == IntPtr.Zero)
        {
            return;
        }
        ShowWindow(window, SwHide);
        if (IsWindowVisible(window))
        {
            throw new Win32Exception("The private SSH console window remained visible.");
        }
    }

    private static InputRecord CreateKeyRecord(
        bool keyDown,
        ushort virtualKey,
        char character,
        uint controlState
    )
    {
        InputRecord record = new InputRecord();
        record.EventType = KeyEvent;
        record.KeyEvent = new KeyEventRecord();
        record.KeyEvent.KeyDown = keyDown;
        record.KeyEvent.RepeatCount = 1;
        record.KeyEvent.VirtualKeyCode = virtualKey;
        record.KeyEvent.VirtualScanCode = (ushort)MapVirtualKey(virtualKey, MapVirtualKeyToScanCode);
        record.KeyEvent.UnicodeChar = character;
        record.KeyEvent.ControlKeyState = controlState;
        return record;
    }

    private static Win32Exception LastWin32(string message)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    private struct InputRecord
    {
        [FieldOffset(0)] internal short EventType;
        [FieldOffset(4)] internal KeyEventRecord KeyEvent;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct KeyEventRecord
    {
        [MarshalAs(UnmanagedType.Bool)] internal bool KeyDown;
        internal ushort RepeatCount;
        internal ushort VirtualKeyCode;
        internal ushort VirtualScanCode;
        internal char UnicodeChar;
        internal uint ControlKeyState;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllocConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleMode(IntPtr consoleInput, uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushConsoleInputBuffer(IntPtr consoleInput);

    [DllImport("kernel32.dll", EntryPoint = "WriteConsoleInputW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteConsoleInput(
        IntPtr consoleInput,
        [In] InputRecord[] records,
        uint recordCount,
        out uint recordsWritten
    );

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint code, uint mapType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
