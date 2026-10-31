{
  "targets": [{
    "target_name": "history_filesystem",
    "sources": ["src/addon.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "NODE_ADDON_API_CPP_EXCEPTIONS_ALL"],
    "cflags_cc!": ["-fno-exceptions"],
    "xcode_settings": {"GCC_ENABLE_CPP_EXCEPTIONS": "YES", "CLANG_CXX_LANGUAGE_STANDARD": "c++17"},
    "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"]}},
    "conditions": [
      ["OS=='win'", {"sources": ["src/windows.cc"], "defines": ["UNICODE", "_UNICODE", "_HAS_EXCEPTIONS=1"], "libraries": ["ntdll.lib"]}],
      ["OS!='win'", {"sources": ["src/posix.cc"], "cflags_cc": ["-std=c++17"]}]
    ]
  }]
}
