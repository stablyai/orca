// Trimmed `/usr/bin/sample` call graphs in its exact line format; the deadlock trunk is from a macOS 26.7 field capture.
const NS_EVENT_THREAD = [
  '    810 Thread_27965339: com.apple.NSEventThread',
  '    + 810 thread_start  (in libsystem_pthread.dylib) + 8  [0x189457c1c]',
  '    +   810 _NSEventThread  (in AppKit) + 184  [0x18da78cac]',
  '    +     810 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x1893bdc34]'
]

const IDLE_MAIN_THREAD = [
  '    810 Thread_27965257   DispatchQueue_1: com.apple.main-thread  (serial)',
  '    + 810 start  (in dyld) + 6992  [0x1890914e4]',
  '    +   810 -[NSApplication run]  (in AppKit) + 368  [0x18d94a13c]',
  '    +     810 __CFRunLoopServiceMachPort  (in CoreFoundation) + 160  [0x18951a158]',
  '    +       810 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x1893bdc34]'
]

export const SCENE_SELF_DEADLOCK_SAMPLE = [
  'Call graph:',
  '    810 Thread_27965257   DispatchQueue_1: com.apple.main-thread  (serial)',
  '    + 810 start  (in dyld) + 6992  [0x1890914e4]',
  '    +   810 BSServiceMainRunLoopSourceHandler  (in BoardServices) + 224  [0x1a3b62690]',
  '    +     810 -[FBSWorkspace _calloutQueue_executeCalloutFromSource:withBlock:]  (in FrontBoardServices) + 188  [0x1a3a51b78]',
  '    +       810 -[NSWindow _setFrameCommon:display:fromServer:]  (in AppKit) + 2724  [0x18d998bb8]',
  '    +         810 -[FBSScene _updateClientSettings:]  (in FrontBoardServices) + 672  [0x1a3a696a8]',
  '    +           810 -[FBSScene _sendUpdate:]  (in FrontBoardServices) + 1120  [0x1a3a69bac]',
  '    +             810 -[BSServiceDispatchQueue performAsyncAndWait:]  (in BoardServices) + 84  [0x1a3b61c30]',
  '    +               810 __DISPATCH_WAIT_FOR_QUEUE__  (in libdispatch.dylib) + 432  [0x1892746ac]',
  '    +                 810 kevent_id  (in libsystem_kernel.dylib) + 8  [0x1893c1a74]',
  ...NS_EVENT_THREAD
].join('\n')

// The same wait held 412 of 810 samples, so the scene queue was released during the capture.
export const TRANSIENT_SCENE_WAIT_SAMPLE = [
  'Call graph:',
  '    810 Thread_27965257   DispatchQueue_1: com.apple.main-thread  (serial)',
  '    + 810 start  (in dyld) + 6992  [0x1890914e4]',
  '    +   810 BSServiceMainRunLoopSourceHandler  (in BoardServices) + 224  [0x1a3b62690]',
  '    +     810 -[FBSWorkspace _calloutQueue_executeCalloutFromSource:withBlock:]  (in FrontBoardServices) + 188  [0x1a3a51b78]',
  '    +       810 -[FBSScene _updateClientSettings:]  (in FrontBoardServices) + 672  [0x1a3a696a8]',
  '    +         810 -[FBSScene _sendUpdate:]  (in FrontBoardServices) + 1120  [0x1a3a69bac]',
  '    +           810 -[BSServiceDispatchQueue performAsyncAndWait:]  (in BoardServices) + 84  [0x1a3b61c30]',
  '    +             412 __DISPATCH_WAIT_FOR_QUEUE__  (in libdispatch.dylib) + 432  [0x1892746ac]',
  '    +             398 _dispatch_client_callout  (in libdispatch.dylib) + 16  [0x1892684b0]',
  ...NS_EVENT_THREAD
].join('\n')

// Blocked synchronous file I/O: a stall the watchdog must never treat as a deadlock.
export const BLOCKED_FILE_WRITE_SAMPLE = [
  'Call graph:',
  '    810 Thread_27965257   DispatchQueue_1: com.apple.main-thread  (serial)',
  '    + 810 start  (in dyld) + 6992  [0x1890914e4]',
  '    +   810 uv_fs_write  (in Electron Framework) + 196  [0x111f2a1c4]',
  '    +     810 write  (in libsystem_kernel.dylib) + 8  [0x1893bf4c8]',
  ...NS_EVENT_THREAD
].join('\n')

// The scene wait on a background thread while the main thread idles is not a main-thread deadlock.
export const BACKGROUND_SCENE_WAIT_SAMPLE = [
  'Call graph:',
  ...IDLE_MAIN_THREAD,
  '    810 Thread_27965400: com.apple.frontboard.workspace',
  '    + 810 -[FBSScene _sendUpdate:]  (in FrontBoardServices) + 1120  [0x1a3a69bac]',
  '    +   810 -[BSServiceDispatchQueue performAsyncAndWait:]  (in BoardServices) + 84  [0x1a3b61c30]',
  '    +     810 __DISPATCH_WAIT_FOR_QUEUE__  (in libdispatch.dylib) + 432  [0x1892746ac]'
].join('\n')
