{
  "targets": [
    {
      "target_name": "orca_window_resize_guard",
      "sources": ["window-resize-guard.m"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_LDFLAGS": ["-framework AppKit"]
      }
    }
  ]
}
