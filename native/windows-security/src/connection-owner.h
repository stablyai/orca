#pragma once

#include <napi.h>

#include <string>

// `process` is a HANDLE with PROCESS_QUERY_LIMITED_INFORMATION. Returns the failed Win32 call and
// sets *code, or nullptr once *sid holds the token's user SID.
const char* ReadProcessUserSid(void* process, std::u16string* sid, unsigned long* code);

Napi::Value TcpClientOwnerAsync(const Napi::CallbackInfo& info);
