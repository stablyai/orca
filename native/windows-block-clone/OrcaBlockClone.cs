using Microsoft.Win32.SafeHandles;
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class OrcaBlockClone
{
    private const int ExitFailure = 1;
    private const int ExitUnavailable = 2;
    private const int ExitTargetExists = 3;
    private const uint FsctlDuplicateExtentsToFile = 0x00098344;
    private const uint FsctlSetSparse = 0x000900C4;
    private const uint InvalidFileAttributes = 0xFFFFFFFF;
    private const long MaxCloneChunk = 1024L * 1024L * 1024L;
    private const int FileBufferSize = 4096;

    [StructLayout(LayoutKind.Sequential)]
    private struct DuplicateExtentsData
    {
        internal IntPtr FileHandle;
        internal long SourceFileOffset;
        internal long TargetFileOffset;
        internal long ByteCount;
    }

    private sealed class CloneUnavailableException : Exception
    {
        internal CloneUnavailableException(string message) : base(message) { }
    }

    private sealed class TargetExistsException : Exception
    {
        internal TargetExistsException(string path) : base("Target already exists: " + path) { }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumePathNameW(
        string fileName,
        StringBuilder volumePathName,
        uint bufferLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeNameForVolumeMountPointW(
        string volumeMountPoint,
        StringBuilder volumeName,
        uint bufferLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeInformationW(
        string rootPathName,
        StringBuilder volumeNameBuffer,
        uint volumeNameSize,
        out uint volumeSerialNumber,
        out uint maximumComponentLength,
        out uint fileSystemFlags,
        StringBuilder fileSystemNameBuffer,
        uint fileSystemNameSize
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetDiskFreeSpaceW(
        string rootPathName,
        out uint sectorsPerCluster,
        out uint bytesPerSector,
        out uint numberOfFreeClusters,
        out uint totalNumberOfClusters
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string fileName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint ioControlCode,
        ref DuplicateExtentsData input,
        uint inputSize,
        IntPtr output,
        uint outputSize,
        out uint bytesReturned,
        IntPtr overlapped
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint ioControlCode,
        IntPtr input,
        uint inputSize,
        IntPtr output,
        uint outputSize,
        out uint bytesReturned,
        IntPtr overlapped
    );

    private sealed class VolumeInfo
    {
        internal string VolumeName;
        internal string FileSystemName;
        internal long ClusterSize;
    }

    private static int Main(string[] args)
    {
        if (args.Length != 3 || (args[0] != "probe" && args[0] != "clone"))
        {
            Console.Error.WriteLine("Usage: orca-block-clone.exe <probe|clone> <source> <target>");
            return ExitFailure;
        }

        try
        {
            string targetProbe = args[0] == "clone"
                ? Path.GetDirectoryName(Path.GetFullPath(args[2]))
                : args[2];
            VolumeInfo sourceVolume;
            if (String.IsNullOrEmpty(targetProbe)
                || !TryGetBlockCloneVolume(args[1], targetProbe, out sourceVolume))
            {
                Console.Error.WriteLine("Source and target must be on the same ReFS volume.");
                return ExitUnavailable;
            }
            if (args[0] == "probe")
            {
                return 0;
            }

            ClonePath(args[1], args[2], sourceVolume.ClusterSize);
            return 0;
        }
        catch (TargetExistsException error)
        {
            Console.Error.WriteLine(error.Message);
            return ExitTargetExists;
        }
        catch (CloneUnavailableException error)
        {
            Console.Error.WriteLine(error.Message);
            return ExitUnavailable;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return ExitFailure;
        }
    }

    private static bool TryGetBlockCloneVolume(
        string source,
        string target,
        out VolumeInfo sourceVolume
    )
    {
        sourceVolume = null;
        if (!PathEntryExists(source) || !PathEntryExists(target))
        {
            return false;
        }
        sourceVolume = ReadVolumeInfo(source);
        VolumeInfo targetVolume = ReadVolumeInfo(target);
        return String.Equals(sourceVolume.VolumeName, targetVolume.VolumeName, StringComparison.OrdinalIgnoreCase)
            && String.Equals(sourceVolume.FileSystemName, "ReFS", StringComparison.OrdinalIgnoreCase)
            && String.Equals(targetVolume.FileSystemName, "ReFS", StringComparison.OrdinalIgnoreCase);
    }

    private static VolumeInfo ReadVolumeInfo(string path)
    {
        StringBuilder rootPath = new StringBuilder(1024);
        if (!GetVolumePathNameW(Path.GetFullPath(path), rootPath, (uint)rootPath.Capacity))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resolve volume for " + path);
        }
        StringBuilder volumeName = new StringBuilder(1024);
        if (!GetVolumeNameForVolumeMountPointW(rootPath.ToString(), volumeName, (uint)volumeName.Capacity))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resolve volume identity for " + path);
        }

        StringBuilder fileSystemName = new StringBuilder(64);
        uint serial;
        uint maximumComponentLength;
        uint fileSystemFlags;
        if (!GetVolumeInformationW(
            rootPath.ToString(),
            null,
            0,
            out serial,
            out maximumComponentLength,
            out fileSystemFlags,
            fileSystemName,
            (uint)fileSystemName.Capacity
        ))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read filesystem for " + path);
        }

        uint sectorsPerCluster;
        uint bytesPerSector;
        uint freeClusters;
        uint totalClusters;
        if (!GetDiskFreeSpaceW(
            rootPath.ToString(),
            out sectorsPerCluster,
            out bytesPerSector,
            out freeClusters,
            out totalClusters
        ))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read cluster size for " + path);
        }
        return new VolumeInfo
        {
            VolumeName = volumeName.ToString(),
            FileSystemName = fileSystemName.ToString(),
            ClusterSize = checked((long)sectorsPerCluster * bytesPerSector)
        };
    }

    private static void ClonePath(string source, string target, long clusterSize)
    {
        if (PathEntryExists(target))
        {
            throw new TargetExistsException(target);
        }
        FileAttributes sourceAttributes = File.GetAttributes(source);
        if ((sourceAttributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new CloneUnavailableException("Reparse-point sources are not block cloned.");
        }
        if ((sourceAttributes & FileAttributes.Directory) != 0)
        {
            CloneDirectoryAtomically(source, target, clusterSize);
            return;
        }
        CloneFileAtomically(source, target, clusterSize);
    }

    private static void CloneDirectoryAtomically(string source, string target, long clusterSize)
    {
        string temporary = BuildTemporaryPath(target);
        try
        {
            Directory.CreateDirectory(temporary);
            CloneDirectoryContents(source, temporary, clusterSize);
            try
            {
                Directory.Move(temporary, target);
            }
            catch (IOException)
            {
                if (PathEntryExists(target))
                {
                    throw new TargetExistsException(target);
                }
                throw;
            }
        }
        finally
        {
            DeleteTemporaryPath(temporary);
        }
    }

    private static void CloneDirectoryContents(string source, string target, long clusterSize)
    {
        foreach (string sourceDirectory in Directory.GetDirectories(source))
        {
            AssertNotReparsePoint(sourceDirectory);
            string targetDirectory = Path.Combine(target, Path.GetFileName(sourceDirectory));
            Directory.CreateDirectory(targetDirectory);
            CloneDirectoryContents(sourceDirectory, targetDirectory, clusterSize);
        }
        foreach (string sourceFile in Directory.GetFiles(source))
        {
            AssertNotReparsePoint(sourceFile);
            CloneFileData(
                sourceFile,
                Path.Combine(target, Path.GetFileName(sourceFile)),
                clusterSize
            );
        }
        ApplyDirectoryMetadata(source, target);
    }

    private static void CloneFileAtomically(string source, string target, long clusterSize)
    {
        string temporary = BuildTemporaryPath(target);
        try
        {
            CloneFileData(source, temporary, clusterSize);
            try
            {
                File.Move(temporary, target);
            }
            catch (IOException)
            {
                if (PathEntryExists(target))
                {
                    throw new TargetExistsException(target);
                }
                throw;
            }
        }
        finally
        {
            DeleteTemporaryPath(temporary);
        }
    }

    private static void CloneFileData(string source, string target, long clusterSize)
    {
        using (FileStream sourceStream = new FileStream(
            source,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            FileBufferSize,
            FileOptions.SequentialScan
        ))
        using (FileStream targetStream = new FileStream(
            target,
            FileMode.CreateNew,
            FileAccess.ReadWrite,
            FileShare.None,
            FileBufferSize,
            FileOptions.SequentialScan
        ))
        {
            long length = sourceStream.Length;
            bool sourceIsSparse = (File.GetAttributes(source) & FileAttributes.SparseFile) != 0;
            if (sourceIsSparse)
            {
                MarkSparse(targetStream.SafeFileHandle, target);
            }
            long cloneLength = length - (length % clusterSize);
            targetStream.SetLength(length);
            for (long offset = 0; offset < cloneLength; offset += MaxCloneChunk)
            {
                long count = Math.Min(MaxCloneChunk, cloneLength - offset);
                CloneExtent(sourceStream.SafeFileHandle, targetStream.SafeFileHandle, offset, count, target);
            }
            if (cloneLength < length)
            {
                sourceStream.Position = cloneLength;
                targetStream.Position = cloneLength;
                sourceStream.CopyTo(targetStream, FileBufferSize);
            }
            targetStream.Flush(true);
        }
        ApplyFileMetadata(source, target);
    }

    private static void CloneExtent(
        SafeFileHandle source,
        SafeFileHandle target,
        long offset,
        long count,
        string targetPath
    )
    {
        DuplicateExtentsData data = new DuplicateExtentsData
        {
            FileHandle = source.DangerousGetHandle(),
            SourceFileOffset = offset,
            TargetFileOffset = offset,
            ByteCount = count
        };
        uint bytesReturned;
        if (!DeviceIoControl(
            target,
            FsctlDuplicateExtentsToFile,
            ref data,
            (uint)Marshal.SizeOf(typeof(DuplicateExtentsData)),
            IntPtr.Zero,
            0,
            out bytesReturned,
            IntPtr.Zero
        ))
        {
            int code = Marshal.GetLastWin32Error();
            throw new CloneUnavailableException(
                "ReFS block clone failed for " + targetPath + ": " + new Win32Exception(code).Message
            );
        }
    }

    private static void MarkSparse(SafeFileHandle target, string targetPath)
    {
        uint bytesReturned;
        if (!DeviceIoControl(
            target,
            FsctlSetSparse,
            IntPtr.Zero,
            0,
            IntPtr.Zero,
            0,
            out bytesReturned,
            IntPtr.Zero
        ))
        {
            int code = Marshal.GetLastWin32Error();
            throw new CloneUnavailableException(
                "Unable to match sparse-file state for " + targetPath + ": " + new Win32Exception(code).Message
            );
        }
    }

    private static void AssertNotReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new CloneUnavailableException("Directory contains a reparse point: " + path);
        }
    }

    private static void ApplyFileMetadata(string source, string target)
    {
        FileInfo sourceInfo = new FileInfo(source);
        File.SetCreationTimeUtc(target, sourceInfo.CreationTimeUtc);
        File.SetLastWriteTimeUtc(target, sourceInfo.LastWriteTimeUtc);
        File.SetLastAccessTimeUtc(target, sourceInfo.LastAccessTimeUtc);
        File.SetAttributes(target, CloneableAttributes(sourceInfo.Attributes));
    }

    private static void ApplyDirectoryMetadata(string source, string target)
    {
        DirectoryInfo sourceInfo = new DirectoryInfo(source);
        Directory.SetCreationTimeUtc(target, sourceInfo.CreationTimeUtc);
        Directory.SetLastWriteTimeUtc(target, sourceInfo.LastWriteTimeUtc);
        Directory.SetLastAccessTimeUtc(target, sourceInfo.LastAccessTimeUtc);
        File.SetAttributes(target, CloneableAttributes(sourceInfo.Attributes) | FileAttributes.Directory);
    }

    private static FileAttributes CloneableAttributes(FileAttributes attributes)
    {
        const FileAttributes mask = FileAttributes.Archive
            | FileAttributes.Hidden
            | FileAttributes.NotContentIndexed
            | FileAttributes.ReadOnly
            | FileAttributes.System
            | FileAttributes.Temporary;
        FileAttributes cloneable = attributes & mask;
        return cloneable == 0 ? FileAttributes.Normal : cloneable;
    }

    private static string BuildTemporaryPath(string target)
    {
        string parent = Path.GetDirectoryName(Path.GetFullPath(target));
        if (String.IsNullOrEmpty(parent))
        {
            throw new IOException("Target has no parent directory: " + target);
        }
        return Path.Combine(parent, ".orca-refs-clone-" + Guid.NewGuid().ToString("N"));
    }

    private static bool PathEntryExists(string path)
    {
        return GetFileAttributesW(Path.GetFullPath(path)) != InvalidFileAttributes;
    }

    private static void DeleteTemporaryPath(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                ClearReadOnly(path);
                Directory.Delete(path, true);
            }
            else if (File.Exists(path))
            {
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(path);
            }
        }
        catch { }
    }

    private static void ClearReadOnly(string root)
    {
        foreach (string entry in Directory.GetFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReadOnly) != 0)
            {
                File.SetAttributes(entry, attributes & ~FileAttributes.ReadOnly);
            }
        }
    }
}
