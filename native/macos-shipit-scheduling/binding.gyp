{
  "targets": [
    {
      "target_name": "orca_shipit_scheduling",
      "sources": ["shipit-scheduling.m"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_LDFLAGS": ["-framework Foundation"]
      }
    }
  ]
}
