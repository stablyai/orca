{
  "targets": [
    {
      "target_name": "orca_frosted_glass",
      "sources": ["frosted-glass.m"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "13.4",
        "OTHER_LDFLAGS": ["-framework AppKit", "-framework QuartzCore"]
      }
    }
  ]
}
