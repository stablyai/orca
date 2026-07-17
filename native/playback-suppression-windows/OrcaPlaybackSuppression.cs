using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class OrcaPlaybackSuppression
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "snapshot")
            {
                using (AudioEndpoint endpoint = AudioEndpoint.OpenDefault())
                {
                    Console.WriteLine(
                        "{\"endpointId\":\"{0}\",\"endpointTarget\":\"{0}\",\"muted\":{1}}",
                        JsonEscape(endpoint.Id),
                        endpoint.Muted ? "true" : "false"
                    );
                }
                return 0;
            }

            if (args.Length == 6 && args[0] == "set-muted" && args[1] == "--endpoint-id" &&
                args[3] == "--endpoint-target")
            {
                bool muted;
                if (!String.Equals(args[2], args[4], StringComparison.Ordinal) ||
                    !Boolean.TryParse(args[5], out muted))
                {
                    throw new ArgumentException("Invalid captured endpoint or mute state.");
                }
                using (AudioEndpoint endpoint = AudioEndpoint.Open(args[4]))
                {
                    if (!String.Equals(endpoint.Id, args[2], StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException("The captured output device is no longer available.");
                    }
                    endpoint.Muted = muted;
                    if (endpoint.Muted != muted)
                    {
                        throw new InvalidOperationException("The output device did not accept the requested mute state.");
                    }
                }
                return 0;
            }

            throw new ArgumentException(
                "Usage: orca-playback-suppression snapshot | set-muted --endpoint-id ID --endpoint-target TARGET true|false"
            );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static string JsonEscape(string value)
    {
        StringBuilder escaped = new StringBuilder();
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': escaped.Append("\\\\"); break;
                case '"': escaped.Append("\\\""); break;
                case '\b': escaped.Append("\\b"); break;
                case '\f': escaped.Append("\\f"); break;
                case '\n': escaped.Append("\\n"); break;
                case '\r': escaped.Append("\\r"); break;
                case '\t': escaped.Append("\\t"); break;
                default:
                    if (character < 0x20) escaped.AppendFormat("\\u{0:x4}", (int)character);
                    else escaped.Append(character);
                    break;
            }
        }
        return escaped.ToString();
    }
}

internal sealed class AudioEndpoint : IDisposable
{
    private IMMDevice device;
    private IAudioEndpointVolume volume;

    private AudioEndpoint(IMMDevice selectedDevice)
    {
        device = selectedDevice;
        try
        {
            Guid interfaceId = typeof(IAudioEndpointVolume).GUID;
            object activated;
            string id;
            Marshal.ThrowExceptionForHR(device.Activate(ref interfaceId, ClassContext.All, IntPtr.Zero, out activated));
            volume = (IAudioEndpointVolume)activated;
            Marshal.ThrowExceptionForHR(device.GetId(out id));
            Id = id;
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    internal string Id { get; private set; }

    internal bool Muted
    {
        get
        {
            Marshal.ThrowExceptionForHR(volume.GetMute(out bool muted));
            return muted;
        }
        set
        {
            Guid context = Guid.Empty;
            Marshal.ThrowExceptionForHR(volume.SetMute(value, ref context));
        }
    }

    internal static AudioEndpoint OpenDefault()
    {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        try
        {
            IMMDevice device;
            // Why: Microsoft recommends eConsole for default stream routing;
            // eMultimedia can resolve differently when device roles diverge.
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(DataFlow.Render, DeviceRole.Console, out device));
            return new AudioEndpoint(device);
        }
        finally
        {
            Marshal.ReleaseComObject(enumerator);
        }
    }

    internal static AudioEndpoint Open(string endpointId)
    {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        try
        {
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDevice(endpointId, out device));
            return new AudioEndpoint(device);
        }
        finally
        {
            Marshal.ReleaseComObject(enumerator);
        }
    }

    public void Dispose()
    {
        if (volume != null) Marshal.ReleaseComObject(volume);
        if (device != null) Marshal.ReleaseComObject(device);
        volume = null;
        device = null;
    }
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumerator { }

internal enum DataFlow { Render, Capture, All }
internal enum DeviceRole { Console, Multimedia, Communications }

[Flags]
internal enum ClassContext
{
    InProcessServer = 1,
    InProcessHandler = 2,
    LocalServer = 4,
    RemoteServer = 16,
    All = InProcessServer | InProcessHandler | LocalServer | RemoteServer
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
internal interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(DataFlow dataFlow, DeviceRole role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
internal interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid interfaceId, ClassContext classContext, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
internal interface IAudioEndpointVolume
{
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
}
