{
  "targets": [
    {
      "target_name": "orca_windows_registry",
      "sources": ["src/addon.cc"],
      "libraries": ["advapi32.lib"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 0 }
      },
      "conditions": [
        ["OS!='win'", { "sources": [] , "type": "none" }]
      ]
    }
  ]
}
