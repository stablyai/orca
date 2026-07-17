using System;
using System.IO;
using System.Runtime.InteropServices;

internal sealed class WindowsBoundedOutputFiles : IDisposable
{
    private const uint HandleFlagInherit = 0x00000001;
    internal const long MaxCapturedBytes = 16 * 1024 * 1024;
    private const int ReplayBufferBytes = 64 * 1024;

    private readonly IntPtr stdinRead;
    private readonly Stream stdoutDestination;
    private readonly Stream stderrDestination;
    private FileStream stdoutCapture;
    private FileStream stderrCapture;
    private FileStream stdoutWriter;
    private FileStream stderrWriter;
    private string stdoutPath;
    private string stderrPath;

    private WindowsBoundedOutputFiles(
        IntPtr stdinRead,
        Stream stdoutDestination,
        Stream stderrDestination
    )
    {
        this.stdinRead = stdinRead;
        this.stdoutDestination = stdoutDestination;
        this.stderrDestination = stderrDestination;
    }

    internal IntPtr StdinRead { get { return stdinRead; } }
    internal IntPtr StdoutWrite
    {
        get { return stdoutWriter.SafeFileHandle.DangerousGetHandle(); }
    }
    internal IntPtr StderrWrite
    {
        get { return stderrWriter.SafeFileHandle.DangerousGetHandle(); }
    }

    internal static WindowsBoundedOutputFiles Create(
        IntPtr stdinRead,
        Stream stdoutDestination,
        Stream stderrDestination
    )
    {
        WindowsBoundedOutputFiles outputs = new WindowsBoundedOutputFiles(
            stdinRead,
            stdoutDestination,
            stderrDestination
        );
        try
        {
            outputs.stdoutCapture = CreateCaptureFile("stdout", out outputs.stdoutPath);
            outputs.stdoutWriter = CreateChildWriter(outputs.stdoutPath, "stdout");
            outputs.stderrCapture = CreateCaptureFile("stderr", out outputs.stderrPath);
            outputs.stderrWriter = CreateChildWriter(outputs.stderrPath, "stderr");
            return outputs;
        }
        catch
        {
            outputs.Dispose();
            throw;
        }
    }

    internal void CloseChildEndsInParent()
    {
        CloseFile(ref stdoutWriter);
        CloseFile(ref stderrWriter);
    }

    internal void EnsureWithinLimits()
    {
        EnsureWithinLimit(stdoutCapture, "stdout");
        EnsureWithinLimit(stderrCapture, "stderr");
    }

    internal void ReplayOutputs()
    {
        EnsureWithinLimits();
        Replay(stdoutCapture, stdoutDestination, "stdout");
        Replay(stderrCapture, stderrDestination, "stderr");
    }

    public void Dispose()
    {
        CloseChildEndsInParent();
        CloseFile(ref stdoutCapture);
        CloseFile(ref stderrCapture);
        DeleteCaptureFile(stdoutPath);
        DeleteCaptureFile(stderrPath);
    }

    private static FileStream CreateCaptureFile(string streamName, out string path)
    {
        path = Path.Combine(
            Path.GetTempPath(),
            "orca-ssh-no-input-" + Guid.NewGuid().ToString("N") + "." + streamName + ".capture"
        );
        return new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.ReadWrite,
            FileShare.Read | FileShare.Write | FileShare.Delete,
            ReplayBufferBytes,
            FileOptions.SequentialScan
        );
    }

    private static FileStream CreateChildWriter(string path, string streamName)
    {
        FileStream writer = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Write,
            FileShare.Read | FileShare.Write | FileShare.Delete,
            ReplayBufferBytes,
            FileOptions.DeleteOnClose | FileOptions.SequentialScan
        );
        try
        {
            if (!SetHandleInformation(
                writer.SafeFileHandle.DangerousGetHandle(),
                HandleFlagInherit,
                HandleFlagInherit
            ))
            {
                throw LastWin32("Unable to make " + streamName + " capture inheritable.");
            }
            return writer;
        }
        catch
        {
            writer.Dispose();
            throw;
        }
    }

    private static void EnsureWithinLimit(FileStream capture, string streamName)
    {
        if (capture.Length > MaxCapturedBytes)
        {
            throw new IOException(
                "SSH " + streamName + " exceeded the 16 MiB diagnostic capture limit."
            );
        }
    }

    private static void Replay(FileStream capture, Stream destination, string streamName)
    {
        capture.Position = 0;
        byte[] buffer = new byte[ReplayBufferBytes];
        long replayed = 0;
        int read;
        while ((read = capture.Read(buffer, 0, buffer.Length)) > 0)
        {
            replayed += read;
            if (replayed > MaxCapturedBytes)
            {
                throw new IOException(
                    "SSH " + streamName + " changed beyond its 16 MiB capture limit."
                );
            }
            destination.Write(buffer, 0, read);
        }
        destination.Flush();
    }

    private static void CloseFile(ref FileStream file)
    {
        if (file != null)
        {
            file.Dispose();
            file = null;
        }
    }

    private static void DeleteCaptureFile(string path)
    {
        if (!String.IsNullOrEmpty(path) && File.Exists(path))
        {
            File.Delete(path);
        }
    }

    private static Exception LastWin32(string message)
    {
        return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
}
