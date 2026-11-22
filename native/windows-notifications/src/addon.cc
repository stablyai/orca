#include <napi.h>
#include <windows.h>

#include <cstdint>

namespace {

using QueryStateData = LONG(NTAPI*)(const std::uint64_t*, const GUID*, const void*,
                                   ULONG*, void*, ULONG*);

Napi::Value GetFocusAssistState(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  static const auto query = reinterpret_cast<QueryStateData>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryWnfStateData"));
  if (!query) {
    return env.Null();
  }

  // The shell publishes the active Quiet Hours profile; its format is undocumented.
  constexpr std::uint64_t activeProfile = 0x0D83063EA3BF1C75ULL;
  ULONG changeStamp = 0;
  DWORD profile = 0;
  ULONG size = sizeof(profile);
  const auto status = query(&activeProfile, nullptr, nullptr, &changeStamp, &profile, &size);
  if (status < 0 || size != sizeof(profile) || profile > 2) {
    return env.Null();
  }
  return Napi::Number::New(env, profile);
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getFocusAssistState", Napi::Function::New(env, GetFocusAssistState));
  return exports;
}

NODE_API_MODULE(orca_windows_notifications, Init)
