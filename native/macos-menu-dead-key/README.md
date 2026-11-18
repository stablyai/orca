# macOS dead-key menu routing

On macOS 27, `-[NSMenu performKeyEquivalent:]` indexes character zero of
`charactersIgnoringModifiers` for key-down events with `NSEventModifierFlagNumericPad`.
An empty dead-key string raises `NSInvalidArgumentException` before Electron or
the renderer can handle it (#43213).

The N-API addon returns `NO` for that event shape, leaving it available to the
normal text-input responder. All other events use the original AppKit method.
Installation is limited to macOS 27 and later, runs on the main thread before
window creation, and survives menu rebuilds. It does not catch native exceptions
or change signal handlers. Remove this workaround after the upstream AppKit fix
is available on the supported macOS versions.

To reproduce the native fault without showing or focusing a window:

```sh
clang -fobjc-arc -framework AppKit native/macos-menu-dead-key/probe-menu-dead-key.m -o /tmp/orca-dead-key-probe
ORCA_BACKGROUND_LAUNCH=1 /tmp/orca-dead-key-probe
```

The unguarded probe exits 42 with `characterAtIndex:` out of bounds. The regression
test builds both Mac architectures and loads the guard into the native probe:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm test config/scripts/desktop-distribution/macos/macos-menu-dead-key.test.mjs --maxWorkers=2
```

On 2026-11-16, m4air (macOS 27.2, 26B123, arm64), accessed through `orca --environment
m4air`, reproduced the report's `NSMenu performKeyEquivalent: + 80` exception
before the fix. The guarded probe passed, including Command+C and a numeric-pad
shortcut. A hidden Orca Electron 43.8.7 dev instance also passed the native menu
event and subsequent native text delivery to its search field. Physical ABNT2
composition and the reported signal-handler spin were not reproduced; an
isolated Electron exception probe terminated instead of spinning.
