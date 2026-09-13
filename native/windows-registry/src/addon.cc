// Read-only Windows registry value enumeration for Orca.
//
// Vendored from windows-native-registry@3.2.2 (MIT, Eugene Pankov), reduced to the one
// entry point Orca calls. The upstream write surface (setValue/createKey/deleteKey) is
// deliberately absent: Orca only ever reads, and shipping RegDeleteTreeW in the app is
// capability we have no use for.
//
// Two upstream defects are fixed here rather than carried over:
//   - the name/data scratch buffers were file-scope statics, so two concurrent reads
//     scribbled over each other; they are per-call locals now (heap for the 1 MB data
//     buffer, which is too large for a thread's stack).
//   - createKey/deleteKey called .c_str() on a temporary Utf16Value(); that use-after-free
//     left with the write surface.

#include <napi.h>
#include <windows.h>

#include <memory>
#include <vector>

namespace {

// Registry value names cap at 32767 wide chars; data at 1 MB, matching upstream's ceiling.
constexpr DWORD kNameMax = 32767;
constexpr DWORD kDataMax = 1024 * 1024;

Napi::Value GetKey(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "getKey(root: number, path: string)").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto root = reinterpret_cast<HKEY>(static_cast<intptr_t>(info[0].As<Napi::Number>().Int64Value()));
  auto path = info[1].As<Napi::String>().Utf16Value();

  HKEY key = nullptr;
  if (RegOpenKeyExW(root, reinterpret_cast<LPCWSTR>(path.c_str()), 0, KEY_READ, &key) !=
      ERROR_SUCCESS) {
    return env.Null();
  }

  // +2 on data so the two-wide-char terminator below always lands inside the buffer.
  std::vector<WCHAR> name(kNameMax);
  auto data = std::make_unique<BYTE[]>(kDataMax + 2);

  auto values = Napi::Array::New(env);
  DWORD index = 0;

  while (true) {
    DWORD nameLength = kNameMax - 1;
    DWORD dataLength = kDataMax - 1;
    DWORD valueType = 0;

    LSTATUS error = RegEnumValueW(key, index, name.data(), &nameLength, nullptr, &valueType,
                                  data.get(), &dataLength);
    if (error != ERROR_SUCCESS) {
      if (error == ERROR_NO_MORE_ITEMS) {
        break;
      }
      RegCloseKey(key);
      return env.Null();
    }

    auto entry = Napi::Object::New(env);
    entry.Set("name", Napi::String::New(env, reinterpret_cast<char16_t*>(name.data())));
    entry.Set("type", Napi::Number::New(env, static_cast<uint32_t>(valueType)));

    // RegEnumValueW reports a byte count, and the registry does not enforce that a string
    // type holds a whole number of WCHARs. On an odd count the terminator appended below
    // straddles a character boundary, so Napi's NAPI_AUTO_LENGTH scan runs past the value.
    const bool isUtf16 =
        valueType == REG_SZ || valueType == REG_EXPAND_SZ || valueType == REG_MULTI_SZ;
    if (isUtf16 && dataLength % sizeof(WCHAR) != 0) {
      RegCloseKey(key);
      return env.Null();
    }

    if (valueType == REG_SZ || valueType == REG_EXPAND_SZ) {
      // RegEnumValueW does not guarantee a terminator when the stored value lacks one.
      data[dataLength] = 0;
      data[dataLength + 1] = 0;
      entry.Set("value", Napi::String::New(env, reinterpret_cast<char16_t*>(data.get())));
    } else if (valueType == REG_DWORD) {
      DWORD dword = 0;
      if (dataLength >= sizeof(DWORD)) {
        memcpy(&dword, data.get(), sizeof(DWORD));
      }
      entry.Set("value", Napi::Number::New(env, static_cast<uint32_t>(dword)));
    } else if (valueType == REG_BINARY) {
      auto bytes = Napi::Array::New(env, dataLength);
      for (DWORD i = 0; i < dataLength; i++) {
        bytes.Set(i, Napi::Number::New(env, static_cast<uint32_t>(data[i])));
      }
      entry.Set("value", bytes);
    } else if (valueType == REG_MULTI_SZ) {
      data[dataLength] = 0;
      data[dataLength + 1] = 0;
      auto parts = Napi::Array::New(env);
      DWORD pos = 0;
      uint32_t partIndex = 0;
      // dataLength includes the trailing empty string's terminator; stop before it.
      while (dataLength >= 2 && pos < dataLength - 2) {
        auto part = Napi::String::New(env, reinterpret_cast<char16_t*>(data.get() + pos));
        parts.Set(partIndex++, part);
        pos += static_cast<DWORD>((part.Utf16Value().length() + 1) * 2);
      }
      entry.Set("value", parts);
    }

    values.Set(index++, entry);
  }

  RegCloseKey(key);
  return values;
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getKey", Napi::Function::New(env, GetKey));
  return exports;
}

NODE_API_MODULE(orca_windows_registry, Init)
