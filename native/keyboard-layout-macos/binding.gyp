{
  "targets": [
    {
      "target_name": "orca_keyboard_layout",
      "sources": ["keyboard-layout.c"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_LDFLAGS": ["-framework Carbon"]
      }
    }
  ]
}
