{
  "targets": [
    {
      "target_name": "orca_menu_dead_key",
      "sources": ["menu-dead-key.m"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_LDFLAGS": ["-framework AppKit"]
      }
    }
  ]
}
